---
applyTo: '**'
---
# Anime Torrent Provider

{% hint style="success" %}
Difficulty: Easy
{% endhint %}

<details>

<summary>Use bootstrapping command</summary>

You can use this third-party tool to help you quickly bootstrap a folder locally

```bash
npx seanime-tool g-template
```

</details>

## Types

{% code title="anime-torrent-provider.d.ts" %}

```typescript
declare type AnimeProviderSmartSearchFilter = "batch" | "episodeNumber" | "resolution" | "query" | "bestReleases"
 
declare type AnimeProviderType = "main" | "special"
 
declare interface AnimeProviderSettings {
    // Indicates whether the extension supports smart search.
    canSmartSearch: boolean
    // Filters that can be used in smart search.
    smartSearchFilters: AnimeProviderSmartSearchFilter[]
    // Indicates whether the extension supports adult content.
    supportsAdult: boolean
    // Type of the provider.
    type: AnimeProviderType
}
 
// Media object passed to 'search' and 'smartSearch' methods.
declare interface Media {
    // AniList ID of the media.
    id: number
    // MyAnimeList ID of the media.
    idMal?: number
    // e.g. "FINISHED", "RELEASING", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"
	// This will be set to "NOT_YET_RELEASED" if the status is unknown.
    status?: string
    // e.g. "TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"
    // This will be set to "TV" if the format is unknown.
    format?: string
    // e.g. "Attack on Titan"
    englishTitle?: string
    // e.g. "Shingeki no Kyojin"
    romajiTitle?: string
    // TotalEpisodes is total number of episodes of the media.
    // This will be -1 if the total number of episodes is unknown / not applicable.
    episodeCount?: number
    // Absolute offset of the media's season.
    // This will be 0 if the media is not seasonal or the offset is unknown.
    absoluteSeasonOffset?: number
    // All alternative titles of the media.
    synonyms: string[]
    // Whether the media is NSFW.
    isAdult: boolean
    // Start date of the media.
    // This will be undefined if it has no start date.
    startDate?: FuzzyDate
}
 
declare interface FuzzyDate {
    year: number
    month?: number
    day?: number
}
 
declare interface AnimeSearchOptions {
    // The media object.
    media: Media
    // The user search query.
    query: string
}
 
declare interface AnimeSmartSearchOptions {
    // The media object.
    media: Media
    // The user search query.
    // This will be empty if your extension does not support custom queries.
    query: string
    // Indicates whether the user wants to search for batch torrents.
    // This will be false if your extension does not support batch torrents.
    batch: boolean
    // The episode number the user wants to search for.
    // This will be 0 if your extension does not support episode number filtering.
    episodeNumber: number
    // The resolution the user wants to search for.
    // This will be empty if your extension does not support resolution filtering.
    resolution: string
    // AniDB Anime ID of the media.
    anidbAID: number
    // AniDB Episode ID of the media.
    anidbEID: number
    // Indicates whether the user wants to search for the best releases.
    // This will be false if your extension does not support filtering by best releases.
    bestReleases: boolean
}
 
declare interface AnimeTorrent {
    name: string
    // Date of the torrent.
	// The date should have RFC3339 format. e.g. "2006-01-02T15:04:05Z07:00"
    date: string
    // Size of the torrent in bytes.
    size: number
    // Formatted size of the torrent. e.g. "1.2 GB"
    // Leave this empty if you want Seanime to format the size.
    formattedSize: string
    // Number of seeders of the torrent.
    seeders: number
    // Number of leechers of the torrent.
    leechers: number
    // Number of downloads of the torrent.
    downloadCount: number
    // Link to the torrent page.
    link: string
    // Download URL of the torrent.
    // Leave this empty if you cannot provide a direct download URL.
    downloadUrl?: string
    // Magnet link of the torrent.
    // Set this to null if you cannot provide a magnet link without scraping.
    magnetLink?: string
    // Info hash of the torrent.
    // Set this to null if you cannot provide an info hash without scraping.
    infoHash?: string
    // The resolution of the torrent.
    // Leave this empty if you want Seanime to parse the resolution from the name.
    resolution?: string
    // Set this to true if you can confirm that the torrent is a batch.
    // Else, Seanime will parse the torrent name to determine if it's a batch.
    isBatch?: boolean
    // Episode number of the torrent.
    // Return -1 if unknown / unable to determine and Seanime will parse the torrent name.
    episodeNumber: number
    // Release group of the torrent.
    // Leave this empty if you want Seanime to parse the release group from the name.
    releaseGroup?: string
    // Set this to true if you can confirm that the torrent is the best release.
    isBestRelease: boolean
    // Set this to true if you can confirm that the torrent matches the anime the user is searching for.
    // e.g. If the torrent was found using the AniDB anime or episode ID
    confirmed: boolean
}
```

{% endcode %}

## Code

{% hint style="warning" %}
Do not change the name of the class. It must be Provider.
{% endhint %}

```typescript
/// <reference path="./anime-torrent-provider.d.ts" />

class Provider {
    private api = "https://example.com"
		
    // Returns the provider settings.
    async getSettings(): AnimeProviderSettings {
	// TODO: Edit this
         return {
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution"],
            supportsAdult: false,
            type: "main",
        }
    }
    // Returns the search results depending on the query.
    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
	// TODO
        return []
    }
    // Returns the search results depending on the search options.
    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
	// TODO
        return []
    }
    // Scrapes the torrent page to get the info hash.
    // If already present in AnimeTorrent, this should just return the info hash without scraping.
    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash
    }
    // Scrapes the torrent page to get the magnet link.
    // If already present in AnimeTorrent, this should just return the magnet link without scraping.
    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink
    }
    // Returns the latest torrents.
    // Note that this is only used by "main" providers.
    async getLatest(): Promise<AnimeTorrent[]> {
	// TODO
        return []
    }
}
```

### Settings

#### type

* `main`: Your extension can be used as **default provider** for torrent search and the Auto Downloader.
* `special`: Your extension can **ONLY** be used for torrent search.

#### canSmartSearch / smartSearchFilters

<figure><img src="https://266901462-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7Mat9fLDAotSl6o8o4P3%2Fuploads%2FqGAduQs9DgfN9RhR15yL%2Fimg-2025-03-16-16-13-14.png?alt=media&#x26;token=27690df9-db8d-47ad-814c-151a9cac6116" alt=""><figcaption></figcaption></figure>

* `batch` : Your extension can look for batches
* `episodeNumber` : Your extension can look for specific episode numbers
* `resolution` : Your extension can filter by resolution
* `query`: Allow the user to change the smart search title
* `bestReleases` : Your extension can find highest-quality torrents

## Example

```typescript
/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {

    api = "https://feed.animetosho.org/json"

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution"],
            supportsAdult: false,
            type: "main",
        }
    }

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        const query = `?q=${encodeURIComponent(opts.query)}&only_tor=1`
        console.log(query)
        const torrents = await this.fetchTorrents(query)
        return torrents.map(t => this.toAnimeTorrent(t))
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const ret: AnimeTorrent[] = []

        if (opts.batch) {
            if (!opts.anidbAID) return []

            let torrents = await this.searchByAID(opts.anidbAID, opts.resolution)

            if (!(opts.media.format == "MOVIE" || opts.media.episodeCount == 1)) {
                torrents = torrents.filter(t => t.num_files > 1)
            }

            for (const torrent of torrents) {
                const t = this.toAnimeTorrent(torrent)
                t.isBatch = true
                ret.push(t)
            }

            return ret
        }

        if (!opts.anidbEID) return []

        const torrents = await this.searchByEID(opts.anidbEID, opts.resolution)

        for (const torrent of torrents) {
            ret.push(this.toAnimeTorrent(torrent))
        }

        return ret
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        const query = `?q=&only_tor=1`
        const torrents = await this.fetchTorrents(query)
        return torrents.map(t => this.toAnimeTorrent(t))
    }

    async searchByAID(aid: number, quality: string): Promise<ToshoTorrent[]> {
        const q = encodeURIComponent(this.formatQuality(quality))
        const query = `?order=size-d&aid=${aid}&q=${q}`
        return this.fetchTorrents(query)
    }

    async searchByEID(eid: number, quality: string): Promise<ToshoTorrent[]> {
        const q = encodeURIComponent(this.formatQuality(quality))
        const query = `?eid=${eid}&q=${q}`
        return this.fetchTorrents(query)
    }

    async fetchTorrents(url: string): Promise<ToshoTorrent[]> {
        const furl = `${this.api}${url}`

        try {
            const response = await fetch(furl)

            if (!response.ok) {
                throw new Error(`Failed to fetch torrents, ${response.statusText}`)
            }

            const torrents: ToshoTorrent[] = await response.json()

            return torrents.map(t => {
                if (t.seeders > 30000) {
                    t.seeders = 0
                }
                if (t.leechers > 30000) {
                    t.leechers = 0
                }
                return t
            })
        }
        catch (error) {
            throw new Error(`Error fetching torrents: ${error}`)
        }
    }

    formatQuality(quality: string): string {
        return quality.replace(/p$/, "")
    }

    toAnimeTorrent(torrent: ToshoTorrent): AnimeTorrent {
        return {
            name: torrent.title,
            date: new Date(torrent.timestamp * 1000).toISOString(),
            size: torrent.total_size,
            formattedSize: "",
            seeders: torrent.seeders,
            leechers: torrent.leechers,
            downloadCount: torrent.torrent_download_count,
            link: torrent.link,
            downloadUrl: torrent.torrent_url,
            magnetLink: torrent.magnet_uri,
            infoHash: torrent.info_hash,
            resolution: "",
            isBatch: false,
            episodeNumber: -1,
            isBestRelease: false,
            confirmed: true,
        }
    }
}

type ToshoTorrent = {
    id: number
    title: string
    link: string
    timestamp: number
    status: string
    tosho_id?: number
    nyaa_id?: number
    nyaa_subdom?: any
    anidex_id?: number
    torrent_url: string
    info_hash: string
    info_hash_v2?: string
    magnet_uri: string
    seeders: number
    leechers: number
    torrent_download_count: number
    tracker_updated?: any
    nzb_url?: string
    total_size: number
    num_files: number
    anidb_aid: number
    anidb_eid: number
    anidb_fid: number
    article_url: string
    article_title: string
    website_url: string
}

```