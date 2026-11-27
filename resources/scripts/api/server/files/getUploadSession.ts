import http from '@/api/http';
import { UploadSessionGrantResult } from '@/components/server/files/upload/chunked/types';

export interface UploadSessionParams {
    directory: string;
    name: string;
    size: number;
    /** File.lastModified (ms). Part of the session identity: the same file picked again resumes. */
    mtime: number;
}

/**
 * Asks the panel whether the server's node supports chunked, resumable uploads and, if it does, for a signed token
 * bound to this file. Nodes running the original Wings answer `supported: false`.
 */
export default async (uuid: string, params: UploadSessionParams): Promise<UploadSessionGrantResult> => {
    const { data } = await http.get(`/api/client/servers/${uuid}/files/upload-session`, { params });
    const a = data.attributes;

    if (!a || !a.supported) {
        return { supported: false };
    }

    return {
        supported: true,
        baseUrl: String(a.base_url).replace(/\/$/, ''),
        token: a.token,
        sessionId: a.session_id,
        replace: Boolean(a.replace),
        chunkSize: Number(a.chunk_size),
        maxParallelChunks: Number(a.max_parallel_chunks),
        maxSize: Number(a.max_size || 0),
        http2: Boolean(a.http2),
        expiresAt: a.expires_at,
    };
};
