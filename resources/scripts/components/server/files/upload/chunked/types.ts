/** What the panel returns for `GET /files/upload-session`. */
export interface UploadSessionGrant {
    supported: true;
    /** https://node:port, without a trailing slash. */
    baseUrl: string;
    token: string;
    sessionId: string;
    /** True when the user may replace an existing file with the same name. */
    replace: boolean;
    chunkSize: number;
    maxParallelChunks: number;
    /** Node upload limit in bytes, 0 when unlimited. */
    maxSize: number;
    http2: boolean;
    expiresAt: string;
}

export type UploadSessionGrantResult = { supported: false } | UploadSessionGrant;

/** What Wings reports about a session (its `session` object). */
export interface RemoteSession {
    session_id: string;
    name: string;
    directory: string;
    size: number;
    chunk_size: number;
    chunk_count: number;
    max_parallel: number;
    /** Inclusive chunk index ranges already stored on the node, e.g. [[0, 9], [12, 12]]. */
    received: Array<[number, number]>;
    received_bytes: number;
    hashed_bytes: number;
    completed?: { sha256: string; size: number } | null;
}

export interface CompleteResult {
    name: string;
    size: number;
    sha256: string;
}

/**
 * Everything the chunked engine needs from the network. The real implementation talks to Wings with axios; tests
 * provide an in-memory node.
 */
export interface WingsApi {
    createSession(grant: UploadSessionGrant): Promise<{ resumed: boolean; session: RemoteSession }>;
    getSession(grant: UploadSessionGrant): Promise<RemoteSession>;
    putChunk(args: {
        grant: UploadSessionGrant;
        index: number;
        blob: Blob;
        sha256: string | null;
        signal: AbortSignal;
        onProgress: (loaded: number) => void;
    }): Promise<{ already: boolean }>;
    complete(grant: UploadSessionGrant): Promise<CompleteResult>;
    abort(grant: UploadSessionGrant): Promise<void>;
}

/** Expands inclusive ranges to a set of chunk indexes. */
export const expandRanges = (ranges: Array<[number, number]>): Set<number> => {
    const set = new Set<number>();

    for (const [from, to] of ranges) {
        for (let i = from; i <= to; i++) {
            set.add(i);
        }
    }

    return set;
};
