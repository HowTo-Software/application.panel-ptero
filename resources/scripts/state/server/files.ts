import { action, Action } from 'easy-peasy';
import { cleanDirectoryPath } from '@/helpers';
import type { UploadPatch, UploadStatus } from '@/components/server/files/upload/uploadEngine';

export interface FileUploadData {
    loaded: number;
    readonly abort: AbortController;
    readonly total: number;
    status?: UploadStatus;
    /** Current transfer rate in bytes per second. */
    speed?: number;
    /** Estimated seconds remaining, null while unknown. */
    eta?: number | null;
    attempt?: number;
    maxAttempts?: number;
    retryInMs?: number | null;
    /** Specific, user-facing explanation of the last failure. Kept while the file is retrying or failed. */
    error?: string | null;
    errorKind?: string | null;
}

export interface ServerFileStore {
    directory: string;
    selectedFiles: string[];
    uploads: Record<string, FileUploadData>;

    setDirectory: Action<ServerFileStore, string>;
    setSelectedFiles: Action<ServerFileStore, string[]>;
    appendSelectedFile: Action<ServerFileStore, string>;
    removeSelectedFile: Action<ServerFileStore, string>;

    pushFileUpload: Action<ServerFileStore, { name: string; data: FileUploadData }>;
    setUploadProgress: Action<ServerFileStore, { name: string; loaded: number }>;
    updateFileUpload: Action<ServerFileStore, { name: string; patch: UploadPatch }>;
    clearFileUploads: Action<ServerFileStore>;
    removeFileUpload: Action<ServerFileStore, string>;
    cancelFileUpload: Action<ServerFileStore, string>;
}

const files: ServerFileStore = {
    directory: '/',
    selectedFiles: [],
    uploads: {},

    setDirectory: action((state, payload) => {
        state.directory = cleanDirectoryPath(payload);
    }),

    setSelectedFiles: action((state, payload) => {
        state.selectedFiles = payload;
    }),

    appendSelectedFile: action((state, payload) => {
        state.selectedFiles = state.selectedFiles.filter((f) => f !== payload).concat(payload);
    }),

    removeSelectedFile: action((state, payload) => {
        state.selectedFiles = state.selectedFiles.filter((f) => f !== payload);
    }),

    clearFileUploads: action((state) => {
        Object.values(state.uploads).forEach((upload) => upload.abort.abort());

        state.uploads = {};
    }),

    pushFileUpload: action((state, payload) => {
        state.uploads[payload.name] = payload.data;
    }),

    setUploadProgress: action((state, { name, loaded }) => {
        if (state.uploads[name]) {
            state.uploads[name].loaded = loaded;
        }
    }),

    updateFileUpload: action((state, { name, patch }) => {
        // The entry disappears when the user cancels; late updates from the engine are then ignored.
        if (state.uploads[name]) {
            Object.assign(state.uploads[name], patch);
        }
    }),

    removeFileUpload: action((state, payload) => {
        if (state.uploads[payload]) {
            delete state.uploads[payload];
        }
    }),

    cancelFileUpload: action((state, payload) => {
        if (state.uploads[payload]) {
            // Abort the request if it is still in flight. If it already completed this is
            // a no-op.
            state.uploads[payload].abort.abort();

            delete state.uploads[payload];
        }
    }),
};

export default files;
