import http from '@/api/http';
import { authenticatedStreamingFetch } from '@/api/authenticatedStreamingFetch';

export interface AssistantMessage {
    role: 'user' | 'assistant';
    content: string;
}

export type WorkshopBrowseMode = 'search' | 'trending' | 'most_subscribed' | 'recent';

export interface WorkshopItem {
    workshopId: string;
    name: string;
    image: string | null;
    description: string;
    modIds: string[];
    modIdSource: 'mod_info' | 'remote_mod_info' | 'steam_metadata' | 'workshop_description' | null;
    tags: string[];
    score: number | null;
    votesUp: number | null;
    votesDown: number | null;
    subscriptions: number | null;
    creatorId: string | null;
    updatedAt: number | null;
}

export interface WorkshopConfiguration {
    path: string;
    revision: string;
    workshopItems: string[];
    mods: string[];
    details: WorkshopItem[];
    detailsError: string | null;
}

export interface WorkshopPagination {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
}

export interface WorkshopSearchResult {
    items: WorkshopItem[];
    pagination: WorkshopPagination;
    mode: 'text' | 'direct';
}

export interface WorkshopCollectionResult {
    collectionId: string;
    name: string;
    total: number;
    items: WorkshopItem[];
    unresolvedIds: string[];
    unavailableIds: string[];
}

export interface CurseForgeMod {
    id: number;
    name: string;
    summary: string;
    image: string | null;
    website: string | null;
    downloadCount: number;
    updatedAt: string | null;
    description?: string;
}

export interface CurseForgeFile {
    id: number;
    displayName: string;
    fileName: string;
    fileDate: string | null;
    fileLength: number;
    releaseType: number;
    gameVersions: string[];
    downloadUrl: string | null;
    isServerPack: boolean;
}

export type CurseForgeSort = 'downloads' | 'popular' | 'updated';

export interface CurseForgeSearchPage {
    items: CurseForgeMod[];
    pagination: { index: number; pageSize: number; resultCount: number; totalCount: number };
}

const workshopItem = (data: any): WorkshopItem => ({
    workshopId: data.workshop_id,
    name: data.name,
    image: data.image,
    description: data.description,
    modIds: data.mod_ids || [],
    modIdSource: data.mod_id_source || null,
    tags: data.tags || [],
    score: data.score ?? null,
    votesUp: data.votes_up ?? null,
    votesDown: data.votes_down ?? null,
    subscriptions: data.subscriptions ?? null,
    creatorId: data.creator_id ?? null,
    updatedAt: data.updated_at,
});

const curseForgeMod = (data: any): CurseForgeMod => ({
    id: data.id,
    name: data.name,
    summary: data.summary,
    image: data.image,
    website: data.website,
    downloadCount: data.download_count,
    updatedAt: data.updated_at,
    description: data.description,
});

const curseForgeFile = (data: any): CurseForgeFile => ({
    id: data.id,
    displayName: data.display_name,
    fileName: data.file_name,
    fileDate: data.file_date,
    fileLength: data.file_length,
    releaseType: data.release_type,
    gameVersions: data.game_versions || [],
    downloadUrl: data.download_url,
    isServerPack: data.is_server_pack ?? false,
});

export const streamAssistant = async (
    uuid: string,
    message: string,
    history: AssistantMessage[],
    serverStatus: string | null,
    signal: AbortSignal,
    onStatus: (status: 'thinking') => void,
    onDelta: (answer: string) => void
): Promise<AssistantMessage> => {
    const response = await authenticatedStreamingFetch(`/api/client/servers/${uuid}/howtoo/assistant/stream`, {
        method: 'POST',
        signal,
        headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
            message,
            history,
            section: window.location.pathname.split('/').pop(),
            server_status: serverStatus,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        try {
            const data = JSON.parse(body);
            throw new Error(data.errors?.[0]?.detail || data.error || `Request failed (${response.status}).`);
        } catch (error) {
            if (error instanceof SyntaxError) throw new Error(`Request failed (${response.status}).`);
            throw error;
        }
    }

    if (!response.body) throw new Error('Streaming is not supported by this browser.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let receivedDone = false;

    const processEvent = (block: string) => {
        const lines = block.split(/\r?\n/);
        const event =
            lines
                .find((line) => line.startsWith('event:'))
                ?.slice(6)
                .trim() || 'message';
        const payload = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
        if (!payload) return;

        const data = JSON.parse(payload);
        if (event === 'status' && data.state === 'thinking') onStatus('thinking');
        if (event === 'message') {
            answer = String(data.answer || '');
            onDelta(answer);
        }
        if (event === 'delta') {
            answer += String(data.content || '');
            onDelta(answer);
        }
        if (event === 'reset') {
            answer = '';
            onDelta('');
        }
        if (event === 'done') receivedDone = true;
        if (event === 'error') throw new Error(String(data.message || 'The assistant is temporarily unavailable.'));
    };

    let streamComplete = false;
    try {
        while (!streamComplete) {
            const result = await reader.read();
            streamComplete = result.done;
            buffer += decoder.decode(result.value, { stream: !streamComplete });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            blocks.forEach(processEvent);
        }

        if (buffer.trim()) processEvent(buffer);
    } finally {
        if (!streamComplete) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }

    if (!receivedDone) throw new Error('The assistant stream ended unexpectedly.');
    if (!answer.trim()) throw new Error('The assistant returned an empty response.');

    return { role: 'assistant', content: answer.trim() };
};

export const getWorkshopConfiguration = async (uuid: string): Promise<WorkshopConfiguration> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/workshop`);

    return {
        path: data.path,
        revision: data.revision,
        workshopItems: data.workshop_items || [],
        mods: data.mods || [],
        details: (data.details || []).map(workshopItem),
        detailsError: data.details_error,
    };
};

export const searchWorkshop = async (
    uuid: string,
    query: string,
    page = 1,
    perPage = 30,
    mode: WorkshopBrowseMode = 'search',
    tags: string[] = []
): Promise<WorkshopSearchResult> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/workshop/search`, {
        params: { query: query || undefined, mode, tags, page, per_page: perPage },
    });
    return {
        items: (data.items || []).map(workshopItem),
        pagination: {
            page: data.pagination?.page ?? page,
            perPage: data.pagination?.per_page ?? perPage,
            total: data.pagination?.total ?? 0,
            totalPages: data.pagination?.total_pages ?? 0,
            hasNext: data.pagination?.has_next ?? false,
        },
        mode: data.mode === 'direct' ? 'direct' : 'text',
    };
};

export const getWorkshopCollection = async (uuid: string, link: string): Promise<WorkshopCollectionResult> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/workshop/collection`, {
        params: { link },
    });
    return {
        collectionId: data.collection_id,
        name: data.name,
        total: data.total,
        items: (data.items || []).map(workshopItem),
        unresolvedIds: data.unresolved_ids || [],
        unavailableIds: data.unavailable_ids || [],
    };
};

export const resolveWorkshopItem = async (uuid: string, workshopId: string): Promise<WorkshopItem> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/workshop/${workshopId}/resolve`);
    return workshopItem(data);
};

export const saveWorkshop = async (
    uuid: string,
    configuration: Pick<WorkshopConfiguration, 'workshopItems' | 'mods' | 'revision'> & {
        workshopMods: Record<string, string[]>;
    },
    restart: boolean
): Promise<WorkshopConfiguration & { restarted: boolean; restartError: string | null }> => {
    const { data } = await http.put(`/api/client/servers/${uuid}/howtoo/workshop`, {
        workshop_items: configuration.workshopItems,
        mods: configuration.mods,
        workshop_mods: configuration.workshopMods,
        revision: configuration.revision,
        action: restart ? 'restart' : 'save',
    });

    return {
        path: data.path,
        revision: data.revision,
        workshopItems: data.workshop_items,
        mods: data.mods,
        details: [],
        detailsError: null,
        restarted: data.restarted,
        restartError: data.restart_error,
    };
};

export const getInstalledCurseForgeMods = async (uuid: string) => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/curseforge/installed`);
    return data.items as Array<{ name: string; size: number; modified_at: string | null }>;
};

const curseForgeSearchPage = (data: any): CurseForgeSearchPage => ({
    items: (data.items || []).map(curseForgeMod),
    pagination: data.pagination || { index: 0, pageSize: 20, resultCount: 0, totalCount: 0 },
});

export const searchCurseForge = async (
    uuid: string,
    query = '',
    index = 0,
    sort: CurseForgeSort = 'downloads'
): Promise<CurseForgeSearchPage> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/curseforge/search`, {
        params: { query, index, sort },
    });
    return curseForgeSearchPage(data);
};

export const searchCurseForgeModpacks = async (
    uuid: string,
    query = '',
    index = 0,
    sort: CurseForgeSort = 'downloads'
): Promise<CurseForgeSearchPage> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/curseforge/modpacks/search`, {
        params: { query, index, sort },
    });
    return curseForgeSearchPage(data);
};

export const getCurseForgeFiles = async (uuid: string, modId: number): Promise<CurseForgeFile[]> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/curseforge/mods/${modId}/files`);
    return (data.items || []).map(curseForgeFile);
};

export const getCurseForgeServerPackFiles = async (uuid: string, modId: number): Promise<CurseForgeFile[]> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/curseforge/modpacks/${modId}/server-files`);
    return (data.items || []).map(curseForgeFile);
};

export const getCurseForgeMod = async (uuid: string, modId: number): Promise<CurseForgeMod> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/howtoo/curseforge/mods/${modId}`);
    return curseForgeMod(data);
};

export const installCurseForgeFile = async (uuid: string, modId: number, fileId: number): Promise<string> => {
    const { data } = await http.post(`/api/client/servers/${uuid}/howtoo/curseforge/install`, {
        mod_id: modId,
        file_id: fileId,
    });
    return data.file_name;
};

export const installCurseForgeModpack = async (uuid: string, modId: number, fileId: number): Promise<string> => {
    const { data } = await http.post(
        `/api/client/servers/${uuid}/howtoo/curseforge/modpacks/install`,
        {
            mod_id: modId,
            file_id: fileId,
        },
        { timeout: 900000 }
    );
    return data.file_name;
};
