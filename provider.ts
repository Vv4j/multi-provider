/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * Multi Aggregator provider for Seanime.
 *
 * Sources:
 * - SeaDex (releases.moe PocketBase)
 * - AnimeTosho (feed.animetosho.org/json)
 * - Nyaa RSS (nyaa.si)
 * - ACG.RIP HTML scrape
 * - AniLiberty API
 * - RuTracker via TorAPI
 *
 * Features:
 * - Parallel fetch
 * - Merge + de-dupe
 * - Prefer SeaDex best releases
 * - Optional Real-Debrid cache-first sorting (heuristic probe)
 */

type ProviderKey = "seadex" | "animetosho" | "nyaa" | "acgrip" | "aniliberty" | "rutracker";

interface ProviderResultMeta {
    provider: ProviderKey;
    cached?: boolean; // determined by RD probe (optional)
}

function boolPref(name: string, def = false): boolean {
    try {
        const v = $getUserPreference(name);
        if (v === undefined || v === null || v === "") return def;
        if (typeof v === "boolean") return v;
        if (typeof v === "string") return v.toLowerCase() === "true";
        return def;
    } catch {
        return def;
    }
}

function numPref(name: string, def = 0): number {
    try {
        const v = $getUserPreference(name);
        const n = typeof v === "number" ? v : parseInt(String(v), 10);
        return isNaN(n) ? def : n;
    } catch {
        return def;
    }
}

function strPref(name: string, def = ""): string {
    try {
        const v = $getUserPreference(name);
        if (v === undefined || v === null) return def;
        return String(v);
    } catch {
        return def;
    }
}

function normalizeResolution(res: string): number {
    // Return numeric height for sorting; unknown -> 0
    const m = (res || "").match(/(\d{3,4})p/i);
    if (!m) return 0;
    return parseInt(m[1], 10) || 0;
}

function safeDateMs(iso: string): number {
    const t = Date.parse(iso || "");
    return isNaN(t) ? 0 : t;
}

function dedupeKey(t: AnimeTorrent): string {
    // Prefer stable unique identifiers
    if (t.infoHash) return "ih:" + t.infoHash.toLowerCase();
    if (t.magnetLink) return "mag:" + t.magnetLink;
    if (t.downloadUrl) return "dl:" + t.downloadUrl;
    if (t.link) return "ln:" + t.link;
    return "nm:" + (t.name || "");
}

function tagProvider(t: AnimeTorrent, provider: ProviderKey): AnimeTorrent & { __meta: ProviderResultMeta } {
    (t as any).__meta = { provider };
    applyProviderPrefix(t as any, provider)
    return t as any;
}

function getMeta(t: AnimeTorrent): ProviderResultMeta | undefined {
    return (t as any).__meta;
}

// Quality definitions
const qualityOrder: Record<string, number> = {
    "BluRay REMUX": 9,
    "BluRay": 8,
    "WEB-DL": 7,
    "WEBRip": 6,
    "HDRip": 5,
    "HC HD-Rip": 4,
    "DVDRip": 3,
    "HDTV": 2,
    "Unknown": 1,
};

const excludedQualities = ["CAM", "TS", "TC", "SCR"];

function getRegexScore(name: string): number {
    // Simple check for known good release groups
    const goodGroups = ["SubsPlease", "Erai-raws", "HorribleSubs", "AnimeKaizoku", "Aergia", "smol", "Vodes"];
    for (const g of goodGroups) {
        if (name.includes(g)) return 1;
    }
    return 0;
}

// ---------------------------
// Real-Debrid Probe (Optional)
// ---------------------------

const RD_BASE = "https://api.real-debrid.com/rest/1.0";

async function rdFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
    // Prefer Bearer header, but also append auth_token for max compatibility.
    // RD docs explicitly allow Authorization: Bearer and auth_token query param.
    const url = path.startsWith("http") ? path : `${RD_BASE}${path}`;
    const sep = url.includes("?") ? "&" : "?";
    const authed = token ? `${url}${sep}auth_token=${encodeURIComponent(token)}` : url;

    const headers: any = Object.assign({}, init?.headers || {});
    if (token) headers["Authorization"] = `Bearer ${token}`;

    return fetch(authed, Object.assign({}, init || {}, { headers }));
}

async function rdProbeMagnetCached(token: string, magnet: string): Promise<boolean> {
    // Heuristic:
    // 1) POST /torrents/addMagnet (201) -> { id }
    // 2) GET /torrents/info/{id} -> if progress == 100 OR status == "downloaded" treat as cached
    // 3) DELETE /torrents/delete/{id}
    //
    // NOTE: Schema is not guaranteed; we defensively parse.
    if (!token || !magnet) return false;

    let id = "";
    try {
        const form = new URLSearchParams();
        form.set("magnet", magnet);

        const addRes = await rdFetch("/torrents/addMagnet", token, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
        });

        if (!addRes.ok) return false;
        const addJson: any = await addRes.json();
        id = String(addJson?.id || "");
        if (!id) return false;

        const infoRes = await rdFetch(`/torrents/info/${encodeURIComponent(id)}`, token, { method: "GET" });
        if (!infoRes.ok) return false;

        const info: any = await infoRes.json();
        const status = String(info?.status || "").toLowerCase();
        const progress = typeof info?.progress === "number" ? info.progress : parseFloat(String(info?.progress || "0"));

        const cached = status === "downloaded" || progress >= 100;

        // cleanup
        await rdFetch(`/torrents/delete/${encodeURIComponent(id)}`, token, { method: "DELETE" }).catch(() => { });
        return cached;
    } catch {
        // attempt cleanup if we got an id
        if (id) {
            await rdFetch(`/torrents/delete/${encodeURIComponent(id)}`, token, { method: "DELETE" }).catch(() => { });
        }
        return false;
    }
}

async function maybeMarkCached(torrents: AnimeTorrent[], token: string, doProbe: boolean, probeLimit: number): Promise<void> {
    if (!doProbe || !token) return;

    // Only probe items that have a magnet link already.
    const candidates = torrents.filter(t => !!t.magnetLink).slice(0, Math.max(0, probeLimit));
    const probePromises = candidates.map(async (t) => {
        const cached = await rdProbeMagnetCached(token, t.magnetLink || "");
        const meta = getMeta(t) || { provider: "nyaa" as ProviderKey };
        meta.cached = cached;
        (t as any).__meta = meta;
    });

    await Promise.allSettled(probePromises);
}

// ---------------------------
// Provider implementations
// ---------------------------

// ---- SeaDex ----
interface SeaDexRecordItem {
    id: string;
    alID: number;
    title: string;
    expand?: { trs?: SeaDexTr[] };
}
interface SeaDexTrFile { length: number; path: string; }
interface SeaDexTr {
    created: string;
    url: string;
    infoHash: string;
    releaseGroup: string;
    tracker: string;
    files: SeaDexTrFile[];
    dualAudio: boolean;
}
const SEADEX_DEFAULT = "https://releases.moe/api/collections/entries/records";

async function seadexFetch(mediaId: number, title: string): Promise<AnimeTorrent[]> {
    const filter = encodeURIComponent(`alID=${mediaId}`);
    const url = `${SEADEX_DEFAULT}?page=1&perPage=1&filter=${filter}&skipTotal=1&expand=trs`;

    const res = await fetch(url);
    if (!res.ok) return [];
    const data: any = await res.json();
    const items: SeaDexRecordItem[] = data?.items || [];
    if (!items.length) return [];

    const record = items[0];
    const trs: SeaDexTr[] = record?.expand?.trs || [];
    if (!trs.length) return [];

    const torrents: AnimeTorrent[] = [];
    for (const tr of trs) {
        if (!tr.infoHash || tr.infoHash === "<redacted>") continue;
        if (tr.tracker !== "Nyaa") continue;
        if (!tr.url || !tr.url.includes("nyaa.si")) continue;

        const size = (tr.files || []).reduce((s, f) => s + (f.length || 0), 0);
        const dualTag = tr.dualAudio ? " [Dual-Audio]" : "";
        const name = `[${tr.releaseGroup}] ${title}${dualTag}`;

        torrents.push(tagProvider({
            name,
            date: tr.created || "",
            size,
            formattedSize: "",
            seeders: -1,
            leechers: 0,
            downloadCount: 0,
            link: tr.url,
            downloadUrl: "",
            infoHash: tr.infoHash || "",
            magnetLink: tr.infoHash ? `magnet:?xt=urn:btih:${tr.infoHash}` : "",
            resolution: "",
            isBatch: true,
            episodeNumber: -1,
            releaseGroup: tr.releaseGroup || "",
            isBestRelease: true,
            confirmed: true
        }, "seadex"));
    }

    return torrents;
}

// ---- AnimeTosho ----
interface AnimeToshoTorrent {
    title: string;
    link: string;
    timestamp: number;
    torrent_url: string;
    magnet_uri: string;
    info_hash: string;
    seeders: number;
    leechers: number;
    torrent_download_count: number;
    total_size: number;
    num_files: number;
}

async function animetoshoSearch(query: string): Promise<AnimeTorrent[]> {
    const url = `https://feed.animetosho.org/json?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const list = await res.json() as AnimeToshoTorrent[];

    return list.map((t) => {
        const md = $habari.parse(t.title);
        const isBatch = (t.num_files || 0) > 1;
        const date = new Date((t.timestamp || 0) * 1000).toISOString();

        let ep = -1;
        if (!isBatch && md.episode_number && md.episode_number.length === 1) {
            ep = parseInt(md.episode_number[0], 10) || -1;
        }
        if (isBatch) ep = -1;

        return tagProvider({
            name: t.title,
            date,
            size: t.total_size || 0,
            formattedSize: "",
            seeders: t.seeders ?? -1,
            leechers: t.leechers ?? -1,
            downloadCount: t.torrent_download_count ?? 0,
            link: t.link || "",
            downloadUrl: t.torrent_url || "",
            magnetLink: t.magnet_uri || "",
            infoHash: t.info_hash || "",
            resolution: md.video_resolution || "",
            isBatch,
            episodeNumber: ep,
            releaseGroup: md.release_group || "",
            isBestRelease: false,
            confirmed: false
        }, "animetosho");
    });
}

// ---- Nyaa RSS ----
interface RawNyaaTorrent {
    name: string;
    link: string;        // guid (page)
    downloadUrl: string; // link (torrent)
    date: string;
    seeders: string;
    leechers: string;
    downloads: string;
    infoHash: string;
    size: string;
}

function parseNyaaRSS(rss: string): RawNyaaTorrent[] {
    const out: RawNyaaTorrent[] = [];

    const getTag = (xml: string, tag: string): string => {
        const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`);
        const m = xml.match(re);
        return m ? m[1].trim() : "";
    };
    const getNyaaTag = (xml: string, tag: string): string => {
        const re = new RegExp(`<nyaa:${tag}[^>]*>([^<]*)</nyaa:${tag}>`);
        const m = xml.match(re);
        return m ? m[1].trim() : "";
    };

    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(rss)) !== null) {
        const item = m[1];
        out.push({
            name: getTag(item, "title"),
            downloadUrl: getTag(item, "link"),
            link: getTag(item, "guid"),
            date: getTag(item, "pubDate"),
            seeders: getNyaaTag(item, "seeders"),
            leechers: getNyaaTag(item, "leechers"),
            downloads: getNyaaTag(item, "downloads"),
            infoHash: getNyaaTag(item, "infoHash"),
            size: getNyaaTag(item, "size"),
        });
    }

    return out;
}

function nyaaSizeToBytes(size: string): number {
    if (!size) return 0;
    const m = size.match(/([\d.]+)\s*([KMGT]?i?B)/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    const base = u.includes("IB") ? 1024 : 1000;
    const pow = (p: number) => Math.pow(base, p);
    if (u.startsWith("K")) return v * pow(1);
    if (u.startsWith("M")) return v * pow(2);
    if (u.startsWith("G")) return v * pow(3);
    if (u.startsWith("T")) return v * pow(4);
    return v;
}

async function nyaaSearch(query: string, category = "1_2", baseUrl = "https://nyaa.si"): Promise<AnimeTorrent[]> {
    const url = `${baseUrl.replace(/\/$/, "")}/?page=rss&q=${encodeURIComponent(query)}&c=${category}&f=0&s=seeders&o=desc`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const rss = await res.text();
    const raw = parseNyaaRSS(rss);

    return raw.map(r => {
        const md = $habari.parse(r.name);
        let dateIso = "";
        const d = new Date(r.date);
        if (!isNaN(d.getTime())) dateIso = d.toISOString();

        let ep = -1;
        if (md.episode_number && md.episode_number.length >= 1) {
            ep = parseInt(md.episode_number[0], 10) || -1;
        }

        // batch guess
        let isBatch = false;
        if (md.episode_number && md.episode_number.length > 1) isBatch = true;
        if (/\b(batch|complete|collection|seasons?|parts?)\b/i.test(r.name)) isBatch = true;
        if (isBatch) ep = -1;

        return tagProvider({
            name: r.name,
            date: dateIso,
            size: Math.round(nyaaSizeToBytes(r.size)),
            formattedSize: r.size,
            seeders: parseInt(r.seeders, 10) || 0,
            leechers: parseInt(r.leechers, 10) || 0,
            downloadCount: parseInt(r.downloads, 10) || 0,
            link: r.link,
            downloadUrl: r.downloadUrl,
            infoHash: r.infoHash || "",
            magnetLink: r.infoHash ? `magnet:?xt=urn:btih:${r.infoHash}` : "",
            resolution: md.video_resolution || "",
            isBatch,
            episodeNumber: ep,
            releaseGroup: md.release_group || "",
            isBestRelease: false,
            confirmed: false
        }, "nyaa");
    });
}

// ---- ACG.RIP ----
async function acgRipSearch(query: string): Promise<AnimeTorrent[]> {
    const base = "https://acg.rip";
    const url = `${base}/?term=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const html = await res.text();
    const $ = LoadDoc(html);
    const torrents: AnimeTorrent[] = [];

    $("table.post-index > tbody > tr").each((i, el) => {
        const titleEl = el.find("td.title > span.title > a");
        const dateEl = el.find("td.date time");
        const sizeEl = el.find("td.size");
        const dlEl = el.find("td.action > a");
        const groupEl = el.find("td.title > span.label-team > a");

        let name = titleEl.text().trim();
        let group = groupEl.text().trim();

        if (!group && name.startsWith("[")) {
            const m = name.match(/^\[([^\]]+)\]/);
            if (m && m[1]) {
                group = m[1];
                name = name.substring(m[0].length).trim();
            }
        }

        const link = base + (titleEl.attr("href") || "");
        const downloadUrl = base + (dlEl.attr("href") || "");
        const sizeStr = sizeEl.text().trim();
        const ts = dateEl.attr("datetime") || "";

        let dateIso = "";
        if (ts) {
            try {
                const d = new Date(parseInt(ts) * 1000);
                if (!isNaN(d.getTime())) dateIso = d.toISOString();
            } catch { }
        }

        torrents.push(tagProvider({
            name,
            date: dateIso,
            size: acgRipParseSize(sizeStr),
            formattedSize: sizeStr,
            seeders: -1,
            leechers: -1,
            downloadCount: 0,
            link,
            downloadUrl,
            magnetLink: "", // computed from torrent file if needed
            infoHash: "",
            resolution: (name.match(/\b(\d{3,4}p)\b/i) || [])[1] || "",
            isBatch: false,
            episodeNumber: -1,
            releaseGroup: group || "",
            isBestRelease: false,
            confirmed: false
        }, "acgrip"));
    });

    return torrents;
}

function acgRipParseSize(sizeStr: string): number {
    const sizeMatch = sizeStr.match(/([\d\.]+)\s*(GB|MB|KB)/i);
    if (!sizeMatch) return 0;
    const size = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2].toUpperCase();
    if (unit === "GB") return Math.round(size * 1024 * 1024 * 1024);
    if (unit === "MB") return Math.round(size * 1024 * 1024);
    if (unit === "KB") return Math.round(size * 1024);
    return 0;
}

// ---- AniLiberty ----
async function aniLibertySearch(query: string): Promise<AnimeTorrent[]> {
    const api = "https://aniliberty.top/api/v1";
    const headers: any = { accept: "application/json", "X-CSRF-TOKEN": "seanime" };

    const url = `${api}/app/search/releases?query=${encodeURIComponent(query)}&include=id,name`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];

    const releases = await res.json();
    const out: AnimeTorrent[] = [];

    for (const r of releases || []) {
        const releaseId = r?.id;
        if (!releaseId) continue;

        const tUrl =
            `${api}/anime/torrents/release/${releaseId}?include=` +
            [
                "id", "hash", "size", "label", "magnet", "seeders", "leechers", "completed_times",
                "created_at", "description", "quality", "codec"
            ].join(",");

        const tRes = await fetch(tUrl, { headers });
        if (!tRes.ok) continue;

        const data = await tRes.json();
        for (const t of data || []) {
            const title = (r?.name?.english || r?.name?.main || t?.label || "AniLiberty").trim();
            const resolution = t?.quality?.description || "";
            const desc = t?.description || "";
            const isBatch = aniLibertyIsBatch(desc);
            const episode = aniLibertyExtractEpisode(desc);

            out.push(tagProvider({
                name: `${title} [${resolution}]`,
                date: t?.created_at || "",
                size: t?.size || 0,
                formattedSize: aniLibertyBytesToHuman(t?.size || 0),
                seeders: t?.seeders ?? -1,
                leechers: t?.leechers ?? -1,
                downloadCount: t?.completed_times ?? 0,
                link: "",
                downloadUrl: "",
                infoHash: t?.hash || "",
                magnetLink: t?.magnet || (t?.hash ? `magnet:?xt=urn:btih:${t?.hash}` : ""),
                resolution,
                isBatch,
                episodeNumber: isBatch ? -1 : episode,
                releaseGroup: "AniLiberty",
                isBestRelease: aniLibertyIsBest(t),
                confirmed: true
            }, "aniliberty"));
        }
    }

    return out;
}

function aniLibertyIsBatch(desc: string): boolean {
    if (!desc) return false;
    return /\d+\s*[-~]\s*\d+|batch|complete|ova/i.test(desc);
}

function aniLibertyExtractEpisode(desc: string): number {
    if (!desc) return -1;
    const match = desc.match(/\b(\d{1,3})\b/);
    return match ? parseInt(match[1], 10) : -1;
}

function aniLibertyIsBest(t: any): boolean {
    return (
        t?.quality?.description === "1080p" &&
        (t?.seeders || 0) > 50 &&
        t?.codec?.value !== "xvid"
    );
}

function aniLibertyBytesToHuman(bytes: number): string {
    if (!bytes) return "";
    const k = 1024;
    const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

// ---- RuTracker (TorAPI) ----
interface TorApiResult {
    Id: string;
    Name: string;
    Size: string;
    Seeds: number;
    Peers: number;
    Date: string;
    Category: string;
    Url: string;
    Download_Count: number;
}
interface TorApiDetail {
    Magnet: string;
    Hash: string;
}

function rutrackerSizeToBytes(sizeStr: string): number {
    if (!sizeStr) return 0;
    const m = sizeStr.trim().toUpperCase().match(/([\d.]+)\s*([A-Z]*)/);
    if (!m) return 0;
    const value = parseFloat(m[1]);
    const unit = m[2];
    const scales: any = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return Math.floor(value * (scales[unit] || 1));
}

async function rutrackerSearch(query: string): Promise<AnimeTorrent[]> {
    const safeQuery = encodeURIComponent(query.trim());
    const url = `https://torapi.vercel.app/api/search/title/rutracker?query=${safeQuery}&page=0`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as TorApiResult[];
    if (!Array.isArray(data)) return [];

    const filtered = data
        .filter(item => item.Category && (item.Category.includes("Аниме") || item.Category.includes("Онгоинги")))
        .slice(0, 10);

    const results = await Promise.all(filtered.map(async (item) => {
        try {
            const dRes = await fetch(`https://torapi.vercel.app/api/search/id/rutracker?query=${item.Id}`);
            if (!dRes.ok) return null;
            const detailsJson = await dRes.json();
            const details: TorApiDetail = detailsJson?.[0];
            if (!details?.Magnet) return null;

            const date = new Date(item.Date);
            const dateIso = isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();

            return tagProvider({
                name: item.Name,
                date: dateIso,
                size: rutrackerSizeToBytes(item.Size),
                formattedSize: item.Size,
                seeders: Number(item.Seeds) || 0,
                leechers: Number(item.Peers) || 0,
                downloadCount: Number(item.Download_Count) || 0,
                link: item.Url || "",
                downloadUrl: "",
                magnetLink: details.Magnet,
                infoHash: details.Hash || "",
                resolution: (item.Name.match(/\b(\d{3,4}p)\b/i) || [])[1] || "",
                isBatch: true,
                episodeNumber: -1,
                releaseGroup: "RuTracker",
                isBestRelease: false,
                confirmed: false
            }, "rutracker");
        } catch {
            return null;
        }
    }));

    return results.filter(Boolean) as AnimeTorrent[];
}

function providerLabel(p: ProviderKey): string {
    switch (p) {
        case "seadex": return "SeaDex"
        case "animetosho": return "AnimeTosho"
        case "nyaa": return "Nyaa"
        case "acgrip": return "ACG.RIP"
        case "aniliberty": return "AniLiberty"
        case "rutracker": return "RuTracker"
    }
}

function applyProviderPrefix(t: AnimeTorrent, p: ProviderKey): AnimeTorrent {
    const lbl = providerLabel(p)
    if (!t.name.startsWith(`[${lbl}]`)) {
        t.name = `[${lbl}] ${t.name}`
    }
    return t
}


// ---------------------------
// Aggregator Provider
// ---------------------------

class Provider {

    public getSettings(): AnimeProviderSettings {
        return {
            type: "main",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: true
        };
    }

    private extractQuality(name: string): string {
        const lower = name.toLowerCase();
        if (lower.includes("remux")) return "BluRay REMUX";
        if (lower.includes("bluray") || lower.includes("bdrip") || lower.includes("bd")) return "BluRay";
        if (lower.includes("web-dl")) return "WEB-DL";
        if (lower.includes("webrip")) return "WEBRip";
        if (lower.includes("hdrip")) return "HDRip";
        if (lower.includes("hc") && lower.includes("hd-rip")) return "HC HD-Rip";
        if (lower.includes("dvdrip")) return "DVDRip";
        if (lower.includes("hdtv")) return "HDTV";
        if (lower.includes("cam")) return "CAM";
        if (lower.includes("ts")) return "TS";
        if (lower.includes("tc")) return "TC";
        if (lower.includes("scr")) return "SCR";
        return "Unknown";
    }

    private getRegexScore(name: string): number {
        // Simple check for known good release groups
        const goodGroups = ["SubsPlease", "Erai-raws", "HorribleSubs", "AnimeKaizoku", "Aergia", "smol", "Vodes"];
        for (const g of goodGroups) {
            if (name.includes(g)) return 1;
        }
        return 0;
    }

    private buildSmartSearchQueries(opts: AnimeSmartSearchOptions): string[] {
        const { media, batch, episodeNumber, resolution, query } = opts
        const hasSingleEpisode = media.episodeCount === 1 || media.format === "MOVIE"

        const allTitles = query ? [this.sanitizeTitle(query)] : this.getAllTitles(media).map(t => this.sanitizeTitle(t)).filter(Boolean)

        const queries: string[] = []

        const addResolution = (q: string) => resolution ? `${q} ${resolution}` : q

        if (hasSingleEpisode) {
            allTitles.forEach(title => {
                queries.push(addResolution(title))
            })
        } else if (batch) {
            const batchTerms = [
                `${this.zeropad(1)} - ${this.zeropad(media.episodeCount || 0)}`,
                `${this.zeropad(1)} ~ ${this.zeropad(media.episodeCount || 0)}`,
                "Batch",
                "Complete",
                "+ OVA",
                "+ Specials",
                "+ Special",
                "Seasons",
                "Parts"
            ]
            allTitles.forEach(title => {
                batchTerms.forEach(term => {
                    queries.push(addResolution(`${title} ${term}`))
                    queries.push(addResolution(`${title} - ${term}`))
                })
            })
        } else {
            // Single episode
            const epVariants = [this.zeropad(episodeNumber), `e${episodeNumber}`, `ep${episodeNumber}`]
            allTitles.forEach(title => {
                epVariants.forEach(ep => {
                    let q = `${title} ${ep}`
                    queries.push(addResolution(q))
                    queries.push(addResolution(`${q} -S0`))
                    // add with dash
                    let q2 = `${title} - ${ep}`
                    queries.push(addResolution(q2))
                    queries.push(addResolution(`${q2} -S0`))
                })
            })

        }

        return [...new Set(queries)]
    }

    private formatQuality(quality: string): string {
        if (!quality) return ""
        return quality.replace(/p$/i, "")
    }

    private sanitizeTitle(t: string): string {
        t = t.replace(/-/g, " ") // Replace hyphens with spaces
        t = t.replace(/[^a-zA-Z0-9\s]/g, "") // Remove non-alphanumeric/space chars
        t = t.replace(/\s+/g, " ") // Trim large spaces
        return t.trim()
    }

    private getAllTitles(media: AnimeSmartSearchOptions["media"]): string[] {
        return [
            media.romajiTitle,
            media.englishTitle,
            ...(media.synonyms || []),
        ].filter(Boolean) as string[] // Filter out null/undefined/empty strings
    }

    private zeropad(v: number | string): string {
        return String(v).padStart(2, "0")
    }









    public async getLatest(): Promise<AnimeTorrent[]> {
        // “Latest” varies by source. Use AnimeTosho latest-ish + Nyaa empty query as a cheap fallback.
        const enableAnimeTosho = boolPref("enableAnimeTosho", true);
        const enableNyaa = boolPref("enableNyaa", true);

        const tasks: Promise<AnimeTorrent[]>[] = [];
        if (enableAnimeTosho) tasks.push(animetoshoSearch(""));
        if (enableNyaa) tasks.push(nyaaSearch("", "1_2", "https://nyaa.si"));

        const results = (await Promise.allSettled(tasks))
            .filter(r => r.status === "fulfilled")
            .flatMap((r: any) => r.value as AnimeTorrent[]);

        return this.finalize(results);
    }

    public async search(options: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        const q = options.query || "";
        const media = options.media;
        return this.runAggregate(q, media, false);
    }

    public async smartSearch(options: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        // For smart search, build better queries using AnimeTosho-style logic
        const queries = this.buildSmartSearchQueries(options);
        const q = queries[0] || options.media.romajiTitle || options.media.englishTitle || "";
        return this.runAggregate(q, options.media, true, options.episodeNumber, options.batch);
    }

    public async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || "";
    }

    public async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink;

        // If we have infoHash, we can construct magnet without scraping.
        if (torrent.infoHash) {
            return `magnet:?xt=urn:btih:${torrent.infoHash}`;
        }

        // If we have a torrent file URL, derive magnet from torrent data.
        if (torrent.downloadUrl && !torrent.downloadUrl.startsWith("magnet:")) {
            try {
                const res = await fetch(torrent.downloadUrl);
                if (!res.ok) return "";
                const torrentData = await res.text();
                const magnet = $torrentUtils.getMagnetLinkFromTorrentData(torrentData);
                return magnet || "";
            } catch {
                // fall through
            }
        }

        // Nyaa page scrape fallback
        if (torrent.link && torrent.link.includes("nyaa.si")) {
            try {
                const res = await fetch(torrent.link);
                if (!res.ok) return "";
                const html = await res.text();
                const $ = LoadDoc(html);

                let magnet = "";
                $("a.card-footer-item, a[href^=\"magnet:\"]").each((i: number, el) => {
                    const href = el.attr("href");
                    if (href && href.startsWith("magnet:")) {
                        magnet = href;
                        return false;
                    }
                });
                return magnet || "";
            } catch {
                return "";
            }
        }

        return "";
    }

    private async runAggregate(query: string, media: AnimeSearchOptions["media"], isSmart: boolean, episodeNumber?: number, batch?: boolean): Promise<AnimeTorrent[]> {
        const enableSeaDex = boolPref("enableSeaDex", true);
        const enableAnimeTosho = boolPref("enableAnimeTosho", true);
        const enableNyaa = boolPref("enableNyaa", true);
        const enableAcgRip = boolPref("enableAcgRip", true);
        const enableAniLiberty = boolPref("enableAniLiberty", true);
        const enableRuTracker = boolPref("enableRuTracker", false);

        const tasks: Promise<AnimeTorrent[]>[] = [];

        // SeaDex wants AniList ID: use media.id if present
        if (enableSeaDex && media?.id) {
            const title = media.romajiTitle || media.englishTitle || query || "Unknown Title";
            tasks.push(seadexFetch(media.id, title));
        }

        if (enableAnimeTosho) tasks.push(animetoshoSearch(query));
        if (enableNyaa) tasks.push(nyaaSearch(query, "1_2", "https://nyaa.si"));
        if (enableAcgRip) tasks.push(acgRipSearch(query));
        if (enableAniLiberty) tasks.push(aniLibertySearch(query));
        if (enableRuTracker) tasks.push(rutrackerSearch(query));

        const settled = await Promise.allSettled(tasks);

        let merged = settled
            .filter(r => r.status === "fulfilled")
            .flatMap((r: any) => r.value as AnimeTorrent[]);

        // Filter by episode if smart search and episode specified
        if (isSmart && episodeNumber !== undefined && episodeNumber > 0 && !batch) {
            const epStr = episodeNumber.toString().padStart(2, '0');
            merged = merged.filter(t => t.episodeNumber === episodeNumber || t.name.toLowerCase().includes(epStr));
        }

        return this.finalize(merged);
    }

    private async finalize(list: AnimeTorrent[]): Promise<AnimeTorrent[]> {
        // 1) De-dupe first, keep best on conflicts
        const map = new Map<string, AnimeTorrent>();
        for (const t of list) {
            const k = dedupeKey(t);
            if (!map.has(k)) map.set(k, t);
            else {
                const existing = map.get(k)!;
                map.set(k, this.pickBetter(existing, t));
            }
        }

        let torrents = [...map.values()];

        // Filter out excluded qualities
        torrents = torrents.filter(t => !excludedQualities.includes(this.extractQuality(t.name)));

        // 2) Initial sort (so “top N” for scraping/probing makes sense)
        torrents.sort((a, b) => this.compare(a, b));

        // 3) Auto-scrape magnets (critical for RD — prioritize top results that lack magnet/infohash)
        const autoScrape = boolPref("autoScrapeMagnets", true);
        const scrapeLimit = numPref("magnetScrapeLimit", 30);

        if (autoScrape && scrapeLimit > 0) {
            const toScrape = torrents
                .filter(t => !t.magnetLink && !t.infoHash && t.link)
                .slice(0, scrapeLimit);

            await Promise.allSettled(toScrape.map(async (t) => {
                const mag = await this.getTorrentMagnetLink(t);
                if (mag) t.magnetLink = mag;
            }));
        }

        // 4) Final sort (by provider priority)        // 5) Final sort (cached-first + SeaDex-first etc.)
        torrents.sort((a, b) => this.compare(a, b));
        return torrents;
    }

    private pickBetter(a: AnimeTorrent, b: AnimeTorrent): AnimeTorrent {
        const better = this.compare(a, b) <= 0 ? a : b
        // compare() returns negative if a should come before b
        return better
    }

    private compare(a: AnimeTorrent, b: AnimeTorrent): number {
        const ma = getMeta(a)
        const mb = getMeta(b)

        // 1) Quality (higher score first)
        const qa = qualityOrder[this.extractQuality(a.name)] || 1;
        const qb = qualityOrder[this.extractQuality(b.name)] || 1;
        if (qa !== qb) return qb - qa;

        // 2) Resolution (higher first)
        const ra = normalizeResolution(a.resolution || "")
        const rb = normalizeResolution(b.resolution || "")
        if (ra !== rb) return rb - ra

        // 3) Regex Patterns (good groups first)
        const rsa = this.getRegexScore(a.name);
        const rsb = this.getRegexScore(b.name);
        if (rsa !== rsb) return rsb - rsa;

        // 4) Provider priority: SeaDex > AnimeTosho > AniLiberty > Nyaa > ACG.RIP > RuTracker
        const providerPriority: Record<ProviderKey, number> = {
            seadex: 6,
            animetosho: 5,
            aniliberty: 4,
            nyaa: 3,
            acgrip: 2,
            rutracker: 1
        };

        const pa = providerPriority[ma?.provider || "nyaa"] || 0;
        const pb = providerPriority[mb?.provider || "nyaa"] || 0;
        if (pa !== pb) return pb - pa;

        // 5) Size (larger first)
        if (a.size !== b.size) return b.size - a.size;

        // 6) Seeders (higher first)
        if (a.seeders !== b.seeders) return b.seeders - a.seeders;

        // 7) Date (newer first)
        const dtA = safeDateMs(a.date || "")
        const dtB = safeDateMs(b.date || "")
        if (dtA !== dtB) return dtB - dtA

        // 8) InfoHash/Magnet availability (prefer those with both)
        const ha = (a.infoHash ? 1 : 0) + (a.magnetLink ? 1 : 0);
        const hb = (b.infoHash ? 1 : 0) + (b.magnetLink ? 1 : 0);
        if (ha !== hb) return hb - ha;

        // 9) Alphabetical (stable sort)
        return (a.name || "").localeCompare(b.name || "")
    }
}