import axios from 'axios';
import {
    CompleteResult,
    RemoteSession,
    UploadSessionGrant,
    WingsApi,
} from '@/components/server/files/upload/chunked/types';

const endpoint = (grant: UploadSessionGrant, path: string, query = ''): string =>
    `${grant.baseUrl}/upload/session${path}?token=${encodeURIComponent(grant.token)}${query}`;

/** Talks to the chunked upload endpoints of the HowTo.Software build of Wings. */
export const defaultWingsApi: WingsApi = {
    createSession: async (grant) => {
        const { data } = await axios.post(endpoint(grant, ''), null);

        return { resumed: Boolean(data.resumed), session: data.session as RemoteSession };
    },

    getSession: async (grant) => {
        const { data } = await axios.get(endpoint(grant, `/${grant.sessionId}`));

        return data.session as RemoteSession;
    },

    putChunk: async ({ grant, index, blob, sha256, signal, onProgress }) => {
        const { data } = await axios.put(
            endpoint(grant, `/${grant.sessionId}/chunks/${index}`, sha256 ? `&sha256=${sha256}` : ''),
            blob,
            {
                signal,
                headers: { 'Content-Type': 'application/octet-stream' },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                onUploadProgress: (event) => onProgress(event.loaded),
            }
        );

        return { already: Boolean(data?.already) };
    },

    complete: async (grant) => {
        const { data } = await axios.post(endpoint(grant, `/${grant.sessionId}/complete`), null);

        return { name: data.name, size: Number(data.size), sha256: String(data.sha256) } as CompleteResult;
    },

    abort: async (grant) => {
        await axios.delete(endpoint(grant, `/${grant.sessionId}`));
    },
};

/** SHA-256 of a chunk as lower-case hex; null when Web Crypto is unavailable (e.g. plain http during development). */
export const sha256Hex = async (blob: Blob): Promise<string | null> => {
    const subtle = (globalThis as any).crypto?.subtle;
    if (!subtle) {
        return null;
    }

    const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());

    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
};
