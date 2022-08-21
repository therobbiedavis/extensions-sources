import {
    Chapter,
    ChapterDetails,
    ContentRating,
    HomeSection,
    LanguageCode,
    Manga,
    MangaStatus,
    MangaTile,
    MangaUpdates,
    PagedResults,
    Request,
    RequestInterceptor,
    Response,
    SearchRequest,
    Section,
    Source,
    SourceInfo,
    SourceStateManager,
    TagSection,
    TagType,
} from 'paperback-extensions-common'

import {
    resetSettingsButton, 
    serverSettingsMenu,
    testServerSettingsMenu,
} from './Settings'

import {
    getAuthorizationString,
    getKavitaAPI,
    getOptions,
    getServerUnavailableMangaTiles,
    searchRequest,
} from './Common'

// This source use Kavita REST API
// https://kavita.org/guides/rest.html

// Manga are represented by `series`
// Chapters are represented by `chapters`

// The Basic Authentication is handled by the interceptor

// Code and method used by both the source and the tracker are defined in the duplicated `KavitaCommon.ts` file

// Due to the self hosted nature of Kavita, this source requires the user to enter its server credentials in the source settings menu
// Some methods are known to throw errors without specific actions from the user. They try to prevent this behavior when server settings are not set.
// This include:
//  - homepage sections
//  - getTags() which is called on the homepage
//  - search method which is called even if the user search in an other source

export const KavitaInfo: SourceInfo = {
    author: 'majora2007 | Joe',
    description: 'Kavita client extension for Paperback',
    icon: 'icon.png',
    name: 'Kavita',
    version: '1.0.0',
    authorWebsite: 'https://github.com/majora2007',
    websiteBaseURL: 'https://kavitareader.com',
    contentRating: ContentRating.EVERYONE,
    language: LanguageCode.ENGLISH,
    sourceTags: [
        {
            text: 'Self hosted',
            type: TagType.RED,
        },
    ],
}

const SUPPORTED_IMAGE_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
]

// Number of items requested for paged requests
const PAGE_SIZE = 40

export const parseMangaStatus = (kavitaStatus: string): MangaStatus => {
    switch (kavitaStatus) {
        case 'ENDED':
            return MangaStatus.COMPLETED
        case 'ONGOING':
            return MangaStatus.ONGOING
        case 'ABANDONED':
            return MangaStatus.ONGOING
        case 'HIATUS':
            return MangaStatus.ONGOING
    }
    return MangaStatus.ONGOING
}

export const capitalize = (tag: string): string => {
    return tag.replace(/^\w/, (c) => c.toUpperCase())
}

export class KavitaRequestInterceptor implements RequestInterceptor {
    /*
        Requests made to Kavita must use a Basic Authentication.
        This interceptor adds an authorization header to the requests.

        NOTE: The authorization header can be overridden by the request
        */

    stateManager: SourceStateManager;
    constructor(stateManager: SourceStateManager) {
        this.stateManager = stateManager
    }

    async interceptResponse(response: Response): Promise<Response> {
        return response
    }

    async interceptRequest(request: Request): Promise<Request> {
        if (request.headers === undefined) {
            request.headers = {}
        }

        // We mustn't call this.getAuthorizationString() for the stateful submission request.
        // This procedure indeed catchs the request used to check user credentials
        // which can happen before an authorizationString is saved,
        // raising an error in getAuthorizationString when we check for its existence
        // Thus we only inject an authorizationString if none are defined in the request
        if (request.headers.authorization === undefined) {
            request.headers.authorization = await getAuthorizationString(
                this.stateManager
            )
        }

        return request
    }
}

export class Kavita extends Source {
    stateManager = createSourceStateManager({});

    requestManager = createRequestManager({
        requestsPerSecond: 4,
        requestTimeout: 20000,
        interceptor: new KavitaRequestInterceptor(this.stateManager),
    });

    override async getSourceMenu(): Promise<Section> {
        return createSection({
            id: 'main',
            header: 'Source Settings',
            rows: async () => [
                serverSettingsMenu(this.stateManager),
                testServerSettingsMenu(this.stateManager, this.requestManager),
                resetSettingsButton(this.stateManager),
            ],
        })
    }

    override async getTags(): Promise<TagSection[]> {
        // This function is called on the homepage and should not throw if the server is unavailable

        // We define four types of tags:
        // - `genre`
        // - `tag`
        // - `collection`
        // - `library`
        // To be able to make the difference between theses types, we append `genre-` or `tag-` at the beginning of the tag id

        let libraryResponse: Response

        // We try to make the requests. If this fail, we return a placeholder tags list to inform the user and prevent the function from throwing an error
        try {
            const kavitaAPI = await getKavitaAPI(this.stateManager)

            const libraryRequest = createRequestObject({
                url: `${kavitaAPI}/libraries/`,
                method: 'GET',
            })
            libraryResponse = await this.requestManager.schedule(libraryRequest, 1)
        } catch (error) {
            console.log(`getTags failed with error: ${error}`)
            return [
                createTagSection({ id: '-1', label: 'Server unavailable', tags: [] }),
            ]
        }

        // The following part of the function should throw if there is an error and thus is not in the try/catch block

        const libraryResult =
            typeof libraryResponse.data === 'string'
                ? JSON.parse(libraryResponse.data)
                : libraryResponse.data

        const tagSections: [TagSection] = [
            createTagSection({ id: '0', label: 'libraries', tags: [] }),
        ]
        
        // For each tag, we append a type identifier to its id and capitalize its label
        tagSections[0].tags = libraryResult.map((elem: { name: string; id: string; }) =>
            createTag({ id: 'library-' + elem.id, label: capitalize(elem.name) })
        )
        

        return tagSections
    }

    async getMangaDetails(mangaId: string): Promise<Manga> {
        /*
                In Kavita a manga is represented by a `serie`
                */
        const kavitaAPI = await getKavitaAPI(this.stateManager)

        const request = createRequestObject({
            url: `${kavitaAPI}/series/${mangaId}/`,
            method: 'GET',
        })

        const response = await this.requestManager.schedule(request, 1)
        const result =
            typeof response.data === 'string'
                ? JSON.parse(response.data)
                : response.data

        const metadata = result.metadata
        const chaptersMetadata = result.chaptersMetadata

        return createManga({
            id: mangaId,
            titles: [metadata.title],
            image: `${kavitaAPI}/Image/series-covver?seriesID=${mangaId}/`,
            status: parseMangaStatus(metadata.status),
            langFlag: metadata.language,
            // Unused: langName
            desc: metadata.summary ? metadata.summary : chaptersMetadata.summary,
            lastUpdate: metadata.lastModified,
        })
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        /*
                In Kavita a chapter is a `chapter`
                */

        const kavitaAPI = await getKavitaAPI(this.stateManager)

        const chaptersRequest = createRequestObject({
            url: `${kavitaAPI}/Series/series-detail?seriesId=/${mangaId}`,
            param: '',
            method: 'GET',
        })

        const chaptersResponse = await this.requestManager.schedule(chaptersRequest, 1)
        const chaptersResult =
            typeof chaptersResponse.data === 'string'
                ? JSON.parse(chaptersResponse.data)
                : chaptersResponse.data

        const chapters: Chapter[] = []

        for (const book of chaptersResult.content.chapters) {
            chapters.push(
                createChapter({
                    id: book.id,
                    mangaId: mangaId,
                    chapNum: parseFloat(book.number),
                    name: `${book.title}`,
                    time: new Date(book.fileLastModified),
                    // @ts-ignore
                    sortingIndex: book.metadata.number
                })
            )
        }

        return chapters
    }

    async getChapterDetails(
        mangaId: string,
        chapterId: string
    ): Promise<ChapterDetails> {
        const kavitaAPI = await getKavitaAPI(this.stateManager)

        const request = createRequestObject({
            url: `${kavitaAPI}/Series/chapter?chapterID=${chapterId}`,
            method: 'GET',
        })

        const data = await this.requestManager.schedule(request, 1)
        const result =
            typeof data.data === 'string' ? JSON.parse(data.data) : data.data

        const pages: string[] = []
        for (const page of result) {
            if (SUPPORTED_IMAGE_TYPES.includes(page.mediaType)) {
                pages.push(`${kavitaAPI}/Reader/image?chapterID=${chapterId}/pages/${page.number}`)
            } else {
                /*pages.push(
                    `${kavitaAPI}/Reader/image?chapterID=${chapterId}/pages/${page.number}?convert=png`
                );*/
            }
        }

        return createChapterDetails({
            id: chapterId,
            longStrip: false,
            mangaId: mangaId,
            pages: pages,
        })
    }

    override async getSearchResults(
        searchQuery: SearchRequest,
        metadata: any
    ): Promise<PagedResults> {
        // This function is also called when the user search in an other source. It should not throw if the server is unavailable.

        return searchRequest(
            searchQuery,
            metadata,
            this.requestManager,
            this.stateManager,
            PAGE_SIZE
        )
    }

    override async getHomePageSections(
        sectionCallback: (section: HomeSection) => void
    ): Promise<void> {
        // This function is called on the homepage and should not throw if the server is unavailable

        // We won't use `await this.getKavitaAPI()` as we do not want to throw an error on
        // the homepage when server settings are not set
        const kavitaAPI = await getKavitaAPI(this.stateManager)
        const { showOnDeck } = await getOptions(this.stateManager)


        if (kavitaAPI === null) {
            console.log('searchRequest failed because server settings are unset')
            const section = createHomeSection({
                id: 'unset',
                title: 'Go to source settings to set your Kavita server credentials.',
                view_more: false,
                items: getServerUnavailableMangaTiles(),
            })
            sectionCallback(section)
            return
        }

        // The source define two homepage sections: new and latest
        const sections = []

        if (showOnDeck) {
            sections.push(createHomeSection({
                id: 'ondeck',
                title: 'On Deck',
                view_more: true,
            }))
        }

        /*
        if (showContinueReading) {
            sections.push(createHomeSection({
                id: 'continue',
                title: 'Continue Reading',
                view_more: false,
            }))
        }
        */

        /*sections.push(createHomeSection({
            id: 'recently-added',
            title: 'Recently added series',
            //type: showRecentFeatured ? HomeSectionType.featured : HomeSectionType.singleRowNormal,
            view_more: true,
        }))*/

        /*sections.push(createHomeSection({
            id: 'recently-updated',
            title: 'Recently updated series',
            view_more: true,
        }))*/
        const promises: Promise<void>[] = []

        for (const section of sections) {
            // Let the app load empty tagSections
            sectionCallback(section)

            let apiPath: string, thumbPath: string, params: string, idProp: string
            switch (section.id) {
                case 'ondeck':
                    apiPath = `${kavitaAPI}/Series/on-deck/`
                    thumbPath = `${kavitaAPI}/Image`
                    params = '?libraryId=0'
                    idProp = 'id'
                    break
                    /*
                case 'continue':
                    apiPath = `${kavitaAPI}/books`;
                    thumbPath = `${kavitaAPI}/books`;
                    params = '?sort=readProgress.readDate,desc&read_status=IN_PROGRESS&page=0&size=20&deleted=false';
                    idProp = 'seriesId';
                    break;
                    */
                case 'recently-added':
                    apiPath = `${kavitaAPI}/Series/recently-added/`
                    thumbPath = `${kavitaAPI}/Image`
                    params = '?libraryId=0'
                    idProp = 'seriesId'
                    break
                case 'recently-updated':
                    apiPath = `${kavitaAPI}/Series/recently-updated-series/`
                    thumbPath = `${kavitaAPI}/Image`
                    params = '?libraryId=0'
                    idProp = 'seriesId'
                    break
                default:
                    apiPath = `${kavitaAPI}/Series/${section.id}`
                    thumbPath = `${kavitaAPI}/Image`
                    params = '?page=0&size=20&deleted=false'
                    idProp = 'id'
                    break
            }

            const request = createRequestObject({
                url: apiPath,
                param: params,
                method: 'GET',
            })

            // Get the section data
            promises.push(
                this.requestManager.schedule(request, 1).then((data) => {
                    const result =
                        typeof data.data === 'string' ? JSON.parse(data.data) : data.data

                    const tiles = []

                    for (const serie of result.content) {
                        tiles.push(
                            createMangaTile({
                                id: serie[idProp],
                                title: createIconText({ text: serie.name}),
                                image: `${thumbPath}/series-cover?seriesId=${serie.id}`,
                            })
                        )
                    }
                    section.items = tiles
                    sectionCallback(section)
                })
            )
        }

        // Make sure the function completes
        await Promise.all(promises)
    }

    override async getViewMoreItems(
        homepageSectionId: string,
        metadata: any
    ): Promise<PagedResults> {
        const kavitaAPI = await getKavitaAPI(this.stateManager)
        const page: number = metadata?.page ?? 0

        const request = createRequestObject({
            url: `${kavitaAPI}/series/${homepageSectionId}`,
            param: `?page=${page}&size=${PAGE_SIZE}&deleted=false`,
            method: 'GET',
        })

        const data = await this.requestManager.schedule(request, 1)
        const result =
            typeof data.data === 'string' ? JSON.parse(data.data) : data.data

        const tiles: MangaTile[] = []
        for (const serie of result.content) {
            tiles.push(
                createMangaTile({
                    id: serie.id,
                    title: createIconText({ text: serie.metadata.title }),
                    image: `${kavitaAPI}/series/${serie.id}/thumbnail`,
                })
            )
        }

        // If no series were returned we are on the last page
        metadata = tiles.length === 0 ? undefined : { page: page + 1 }

        return createPagedResults({
            results: tiles,
            metadata: metadata,
        })
    }

    override async filterUpdatedManga(
        mangaUpdatesFoundCallback: (updates: MangaUpdates) => void,
        time: Date,
        ids: string[]
    ): Promise<void> {
        const kavitaAPI = await getKavitaAPI(this.stateManager)

        // We make requests of PAGE_SIZE titles to `series/updated/` until we got every titles
        // or we got a title which `lastModified` metadata is older than `time`
        let page = 0
        const foundIds: string[] = []
        let loadMore = true

        while (loadMore) {
            const request = createRequestObject({
                url: `${kavitaAPI}/series/updated/`,
                param: `?page=${page}&size=${PAGE_SIZE}&deleted=false`,
                method: 'GET',
            })

            const data = await this.requestManager.schedule(request, 1)
            const result =
                typeof data.data === 'string' ? JSON.parse(data.data) : data.data

            for (const serie of result.content) {
                const serieUpdated = new Date(serie.metadata.lastModified)

                if (serieUpdated >= time) {
                    if (ids.includes(serie)) {
                        foundIds.push(serie)
                    }
                } else {
                    loadMore = false
                    break
                }
            }

            // If no series were returned we are on the last page
            if (result.content.length === 0) {
                loadMore = false
            }

            page = page + 1

            if (foundIds.length > 0) {
                mangaUpdatesFoundCallback(
                    createMangaUpdates({
                        ids: foundIds,
                    })
                )
            }
        }
    }
}
