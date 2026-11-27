/**
 * Unfinished chunked uploads, remembered in this browser so the file manager can tell the user which ones can be
 * resumed after closing the tab or the browser.
 *
 * Nothing here is needed for resuming to work: the node keeps the data and the session id is derived from the file
 * itself, so selecting the same file again continues the upload. This only makes the possibility visible.
 * Everything is best effort; storage can be unavailable or cleared.
 */
export interface PendingUpload {
    sessionId: string;
    name: string;
    directory: string;
    size: number;
    savedAt: number;
}

const KEY = (serverUuid: string) => `howto:pending-uploads:${serverUuid}`;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const read = (serverUuid: string): PendingUpload[] => {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(KEY(serverUuid)) || '[]');

        return (Array.isArray(parsed) ? parsed : []).filter(
            (p) => p && typeof p.sessionId === 'string' && Date.now() - Number(p.savedAt) < MAX_AGE_MS
        );
    } catch {
        return [];
    }
};

const write = (serverUuid: string, list: PendingUpload[]): void => {
    try {
        window.localStorage.setItem(KEY(serverUuid), JSON.stringify(list.slice(-20)));
    } catch {
        // Private mode, quota or blocked storage: the feature just stays invisible.
    }
};

export const listPending = (serverUuid: string): PendingUpload[] => read(serverUuid);

export const savePending = (serverUuid: string, entry: Omit<PendingUpload, 'savedAt'>): void => {
    write(serverUuid, [
        ...read(serverUuid).filter((p) => p.sessionId !== entry.sessionId),
        { ...entry, savedAt: Date.now() },
    ]);
};

export const removePending = (serverUuid: string, sessionId: string): void => {
    write(
        serverUuid,
        read(serverUuid).filter((p) => p.sessionId !== sessionId)
    );
};
