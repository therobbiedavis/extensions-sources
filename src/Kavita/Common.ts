import {
    SearchRequest,
    PagedResults,
    SourceStateManager,
    RequestManager,
    Response
} from 'paperback-extensions-common'

export function getServerUnavailableMangaTiles() {
    // This tile is used as a placeholder when the server is unavailable
    return [
        createMangaTile({
            id: 'placeholder-id',
            title: createIconText({ text: 'Server' }),
            image: '',
            subtitleText: createIconText({ text: 'unavailable' }),
        }),
    ]
}

export async function searchRequest(
    searchQuery: SearchRequest,
    metadata: any,
    requestManager: RequestManager,
    stateManager: SourceStateManager,
    page_size: number
): Promise<PagedResults> {
    // This function is also called when the user search in an other source. It should not throw if the server is unavailable.

    // We won't use `await this.getKomgaAPI()` as we do not want to throw an error
    const kavitaAPI = await getKavitaAPI(stateManager)

    if (kavitaAPI === null) {
        console.log('searchRequest failed because server settings are unset')
        return createPagedResults({
            results: getServerUnavailableMangaTiles(),
        })
    }

    const page: number = metadata?.page ?? 0

    const paramsList = [`page=${page}`, `size=${page_size}`]

    if (searchQuery.title !== undefined && searchQuery.title !== '') {
        paramsList.push('search=' + encodeURIComponent(searchQuery.title))
    }
    if (searchQuery.includedTags !== undefined) {
        searchQuery.includedTags.forEach((tag) => {
            // There are two types of tags: `tag` and `genre`
            if (tag.id.substr(0, 4) == 'tag-') {
                paramsList.push('tag=' + encodeURIComponent(tag.id.substring(4)))
            }
            if (tag.id.substr(0, 6) == 'genre-') {
                paramsList.push('genre=' + encodeURIComponent(tag.id.substring(6)))
            }
            if (tag.id.substr(0, 11) == 'collection-') {
                paramsList.push('collection_id=' + encodeURIComponent(tag.id.substring(11)))
            }
            if (tag.id.substr(0, 8) == 'library-') {
                paramsList.push('library_id=' + encodeURIComponent(tag.id.substring(8)))
            }
        })
    }

    let paramsString = ''
    if (paramsList.length > 0) {
        paramsString = '?' + paramsList.join('&')
    }

    const request = createRequestObject({
        url: `${kavitaAPI}/series`,
        method: 'GET',
        param: paramsString,
    })

    // We don't want to throw if the server is unavailable
    let data: Response
    try {
        data = await requestManager.schedule(request, 1)
    } catch (error) {
        console.log(`searchRequest failed with error: ${error}`)
        return createPagedResults({
            results: getServerUnavailableMangaTiles(),
        })
    }

    const result =
        typeof data.data === 'string' ? JSON.parse(data.data) : data.data

    const tiles = []
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
        metadata,
    })
}

// 
// KAVITA API STATE METHODS
//

const DEFAULT_KAVITA_SERVER_ADDRESS = 'http://192.168.1.35:4200'
const DEFAULT_KAVITA_API = '/api/'
const DEFAULT_KAVITA_APIKEY = 'Admin'
const DEFAULT_SHOW_ON_DECK = true

export async function getAuthorizationString(stateManager: SourceStateManager): Promise<string> {
    return (await stateManager.keychain.retrieve('authorization') as string | undefined) ?? ''
}

export async function getKavitaAPI(stateManager: SourceStateManager): Promise<string> {
    return (await stateManager.retrieve('kavitaAPI') as string | undefined) ?? DEFAULT_KAVITA_API
}

export async function getOptions(stateManager: SourceStateManager): Promise<{ showOnDeck: boolean }> {
    const showOnDeck = (await stateManager.retrieve('showOnDeck') as boolean) ?? DEFAULT_SHOW_ON_DECK

    return { showOnDeck }
}

export async function retrieveStateData(stateManager: SourceStateManager) {
    // Return serverURL, serverUsername and serverPassword saved in the source.
    // Used to show already saved data in settings

    const serverURL = (await stateManager.retrieve('serverAddress') as string) ?? DEFAULT_KAVITA_SERVER_ADDRESS
    const serverAPIkey = (await stateManager.keychain.retrieve('serverAPIkey') as string) ?? DEFAULT_KAVITA_APIKEY
    const showOnDeck = (await stateManager.retrieve('showOnDeck') as boolean) ?? DEFAULT_SHOW_ON_DECK

    return { serverURL, serverAPIkey, showOnDeck }
}

export async function setStateData(stateManager: SourceStateManager, data: Record<string, any>) {
    await setKavitaServerAddress(
        stateManager,
        data['serverAddress'] ?? DEFAULT_KAVITA_SERVER_ADDRESS
    )
    await setCredentials(
        stateManager,
        data['serverAPIkey'] ?? DEFAULT_KAVITA_APIKEY,
    )
    await setOptions(
        stateManager,
        data['showOnDeck'] ?? DEFAULT_SHOW_ON_DECK
    )
}

async function setKavitaServerAddress(stateManager: SourceStateManager, apiUri: string) {
    await stateManager.store('serverAddress', apiUri)
    await stateManager.store('kavitaAPI', createKavitaAPI(apiUri))
}

async function setCredentials(stateManager: SourceStateManager, apikey: string) 
{
    await stateManager.keychain.store('apikey', apikey)
    await stateManager.keychain.store('authorization', createAuthorizationString(stateManager, apikey))
}

async function setOptions(stateManager: SourceStateManager, showOnDeck: boolean ) {
    await stateManager.store('showOnDeck', showOnDeck)
}

function createAuthorizationString(stateManager: SourceStateManager, apikey: string) {
    
    const kavitaAPI = stateManager.retrieve('kavitaAPI')

    const request = createRequestObject({
        url: `${kavitaAPI}/Plugin/authenticate`,
        method: 'POST',
        param: '?apiKey='+apikey,
        incognito: true, // We don't want the authorization to be cached
    })
    const data = JSON.parse(request.toString())
    return 'Bearer ' + data.token
}

function createKavitaAPI(serverAddress: string): string {
    return serverAddress + (serverAddress.slice(-1) === '/' ? 'api' : '/api/')
}