import { SESSION_EXPIRED_MESSAGE } from '@/api/authenticatedStreamingFetch';
import http from '@/api/http';
import { getWorkshopCollection, saveWorkshop, searchWorkshop, streamAssistant } from './howtoo';
import fs from 'fs';
import path from 'path';

jest.mock('@/api/http', () => ({
    __esModule: true,
    default: { get: jest.fn(), put: jest.fn() },
}));

const encode = (value: string) => new TextEncoder().encode(value);

const streamingResponse = (...chunks: string[]): Response => {
    const reader = {
        read: jest.fn(),
        cancel: jest.fn().mockResolvedValue(undefined),
        releaseLock: jest.fn(),
    };

    chunks.forEach((chunk) => reader.read.mockResolvedValueOnce({ done: false, value: encode(chunk) }));
    reader.read.mockResolvedValueOnce({ done: true, value: undefined });

    return {
        ok: true,
        status: 200,
        body: { getReader: () => reader },
    } as unknown as Response;
};

describe('streamAssistant', () => {
    const originalFetch = global.fetch;
    let timeoutSpy: jest.SpyInstance;

    beforeEach(() => {
        Object.defineProperty(global, 'document', {
            configurable: true,
            value: { cookie: 'pterodactyl_session=session-value; XSRF-TOKEN=csrf%3Dtoken' },
        });
        Object.defineProperty(global, 'window', {
            configurable: true,
            value: { location: { pathname: '/server/server-id/assistant' } },
        });
    });

    afterEach(() => {
        global.fetch = originalFetch;
        timeoutSpy?.mockRestore();
    });

    it('authenticates the streaming POST and processes status, delta and done events', async () => {
        const onStatus = jest.fn();
        const onDelta = jest.fn();
        global.fetch = jest
            .fn()
            .mockResolvedValue(
                streamingResponse(
                    'event: status\ndata: {"state":"thinking"}\n\n',
                    'event: delta\ndata: {"content":"Hello"}\n\n',
                    'event: done\ndata: {"completed":true}\n\n'
                )
            );

        await expect(
            streamAssistant('server-id', 'hello', [], 'running', new AbortController().signal, onStatus, onDelta)
        ).resolves.toEqual({ role: 'assistant', content: 'Hello' });

        expect(onStatus).toHaveBeenCalledWith('thinking');
        expect(onDelta).toHaveBeenLastCalledWith('Hello');
        const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Headers;
        expect(url).toBe('/api/client/servers/server-id/howtoo/assistant/stream');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('same-origin');
        expect(headers.get('Accept')).toBe('text/event-stream');
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get('X-Requested-With')).toBe('XMLHttpRequest');
        expect(headers.get('X-XSRF-TOKEN')).toBe('csrf=token');
    });

    it('supports a reset event without reloading the page', async () => {
        const onDelta = jest.fn();
        global.fetch = jest
            .fn()
            .mockResolvedValue(
                streamingResponse(
                    'event: delta\ndata: {"content":"partial local answer"}\n\n',
                    'event: reset\ndata: {"reason":"stream_reset"}\n\n',
                    'event: status\ndata: {"state":"thinking"}\n\n',
                    'event: delta\ndata: {"content":"Ollama answer"}\n\n',
                    'event: done\ndata: {"completed":true}\n\n'
                )
            );

        await expect(
            streamAssistant('server-id', 'help', [], 'running', new AbortController().signal, jest.fn(), onDelta)
        ).resolves.toEqual({ role: 'assistant', content: 'Ollama answer' });
        expect(onDelta.mock.calls.map(([value]) => value)).toEqual(['partial local answer', '', 'Ollama answer']);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('shows a friendly error when the session has expired', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 419 } as Response);

        await expect(
            streamAssistant('server-id', 'hello', [], null, new AbortController().signal, jest.fn(), jest.fn())
        ).rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    });

    it('does not expose provider credentials in the browser request', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValue(
                streamingResponse(
                    'event: delta\ndata: {"content":"Safe"}\n\n',
                    'event: done\ndata: {"completed":true}\n\n'
                )
            );

        await streamAssistant('server-id', 'hello', [], null, new AbortController().signal, jest.fn(), jest.fn());

        const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
        const requestHeaders: Record<string, string> = {};
        (init.headers as Headers).forEach((value, key) => {
            requestHeaders[key] = value;
        });
        const serializedRequest = JSON.stringify({
            headers: requestHeaders,
            body: init.body,
        });
        expect(serializedRequest).not.toMatch(/ollama|api[_-]?key|Bearer/i);

        const frontendSources = [
            path.join(__dirname, 'howtoo.ts'),
            path.join(__dirname, '..', 'authenticatedStreamingFetch.ts'),
        ]
            .map((file) => fs.readFileSync(file, 'utf8'))
            .join('\n');
        expect(frontendSources).not.toMatch(/OLLAMA_(?:API_KEY|BASE_URL)|Bearer\s+[A-Za-z0-9_-]{8,}/);
    });

    it('does not add a fixed 20 second frontend timeout', async () => {
        timeoutSpy = jest.spyOn(global, 'setTimeout');
        global.fetch = jest
            .fn()
            .mockResolvedValue(
                streamingResponse(
                    'event: delta\ndata: {"content":"Hello"}\n\n',
                    'event: done\ndata: {"completed":true}\n\n'
                )
            );

        await streamAssistant('server-id', 'hello', [], null, new AbortController().signal, jest.fn(), jest.fn());

        expect(timeoutSpy.mock.calls.some((call) => call[1] === 20000)).toBe(false);
    });
});

describe('searchWorkshop', () => {
    beforeEach(() => jest.mocked(http.get).mockReset());

    it('passes explicit pagination and maps Load More metadata', async () => {
        jest.mocked(http.get).mockResolvedValue({
            data: {
                items: [{ workshop_id: '2', name: 'Page two', mod_ids: [] }],
                pagination: { page: 2, per_page: 30, total: 61, total_pages: 3, has_next: true },
                mode: 'text',
            },
        });

        const result = await searchWorkshop('server-id', 'common', 2, 30, 'search');

        expect(http.get).toHaveBeenCalledWith('/api/client/servers/server-id/howtoo/workshop/search', {
            params: { query: 'common', mode: 'search', tags: [], page: 2, per_page: 30 },
        });
        expect(result.items[0].workshopId).toBe('2');
        expect(result.pagination).toEqual({ page: 2, perPage: 30, total: 61, totalPages: 3, hasNext: true });
    });

    it('requests a filtered Workshop catalog without a search phrase', async () => {
        jest.mocked(http.get).mockResolvedValue({
            data: {
                items: [{ workshop_id: '3', name: 'Build 41 mod', tags: ['Build 41', 'Animals'], mod_ids: [] }],
                pagination: { page: 1, per_page: 30, total: 1, total_pages: 1, has_next: false },
            },
        });

        await searchWorkshop('server-id', '', 1, 30, 'trending', ['Build 41', 'Animals']);

        expect(http.get).toHaveBeenCalledWith('/api/client/servers/server-id/howtoo/workshop/search', {
            params: { query: undefined, mode: 'trending', tags: ['Build 41', 'Animals'], page: 1, per_page: 30 },
        });
    });

    it('keeps catalog cards and large result sets visually controlled', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'components', 'server', 'howtoo', 'ProjectZomboidWorkshopContainer.tsx'),
            'utf8'
        );
        const catalog = fs.readFileSync(
            path.join(__dirname, '..', '..', 'components', 'server', 'howtoo', 'WorkshopCatalog.tsx'),
            'utf8'
        );

        expect(catalog).toContain('-webkit-line-clamp: 2');
        expect(source).toContain('Carregar mais');
    });
});

describe('saveWorkshop', () => {
    beforeEach(() => jest.mocked(http.put).mockReset());

    it('submits the complete pending configuration before requesting a restart', async () => {
        jest.mocked(http.put).mockResolvedValue({
            data: {
                path: '/.cache/Server/servertest.ini',
                revision: 'next',
                workshop_items: ['1'],
                mods: ['Alpha'],
                restarted: true,
                restart_error: null,
            },
        });

        const result = await saveWorkshop(
            'server-id',
            { workshopItems: ['1'], mods: ['Alpha'], workshopMods: { '1': ['Alpha'] }, revision: 'current' },
            true
        );

        expect(http.put).toHaveBeenCalledWith('/api/client/servers/server-id/howtoo/workshop', {
            workshop_items: ['1'],
            mods: ['Alpha'],
            workshop_mods: { '1': ['Alpha'] },
            revision: 'current',
            action: 'restart',
        });
        expect(result.restarted).toBe(true);
    });
});


describe('getWorkshopCollection', () => {
    beforeEach(() => jest.mocked(http.get).mockReset());

    it('loads collection children and Mod IDs without sending a server update', async () => {
        jest.mocked(http.get).mockResolvedValue({
            data: {
                collection_id: '3730991494',
                name: 'PZ collection',
                total: 3,
                items: [
                    { workshop_id: '11', name: 'First mod', mod_ids: ['FirstMod'] },
                    { workshop_id: '12', name: 'Second mod', mod_ids: [] },
                ],
                unresolved_ids: ['12'],
                unavailable_ids: ['13'],
            },
        });
        const result = await getWorkshopCollection(
            'server-id',
            'https://steamcommunity.com/sharedfiles/filedetails/?id=3730991494'
        );
        expect(http.get).toHaveBeenCalledWith('/api/client/servers/server-id/howtoo/workshop/collection', {
            params: { link: 'https://steamcommunity.com/sharedfiles/filedetails/?id=3730991494' },
        });
        expect(result.collectionId).toBe('3730991494');
        expect(result.items[0].modIds).toEqual(['FirstMod']);
        expect(result.unresolvedIds).toEqual(['12']);
        expect(result.unavailableIds).toEqual(['13']);
        expect(http.put).not.toHaveBeenCalled();
    });
});
