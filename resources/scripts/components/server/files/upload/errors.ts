import { translateUiText } from '@/i18n/uiTranslations';

export type UploadErrorKind =
    | 'canceled'
    | 'network'
    | 'stalled'
    | 'token_rejected'
    | 'too_large'
    | 'insufficient_storage'
    | 'forbidden'
    | 'proxy_limit'
    | 'server'
    | 'bad_request'
    | 'integrity'
    | 'finalize'
    | 'exists'
    | 'unknown';

/** Where in the flow the failure happened: asking the panel for a signed URL, or sending bytes to Wings. */
export type UploadPhase = 'sign' | 'upload' | 'verify' | 'finalize';

export interface ClassifiedUploadError {
    kind: UploadErrorKind;
    /** Whether starting the whole upload again (with a fresh token) can reasonably succeed. */
    retryable: boolean;
    /** Localized, user-facing explanation. */
    message: string;
    status?: number;
}

/** Thrown by the engine when the stall watchdog aborted an attempt that stopped receiving data. */
export class UploadStalledError extends Error {
    readonly seconds: number;

    constructor(seconds: number) {
        super(`Upload stalled for ${seconds}s`);
        this.name = 'UploadStalledError';
        this.seconds = seconds;
    }
}

/** Thrown for failures that are detected by our own checks (size mismatch, finalize problems). */
export class UploadFlowError extends Error {
    readonly info: ClassifiedUploadError;

    constructor(info: ClassifiedUploadError) {
        super(info.message);
        this.name = 'UploadFlowError';
        this.info = info;
    }
}

const wingsMessage = (error: any): string => {
    const data = error?.response?.data;

    if (data && typeof data === 'object') {
        if (typeof data.error === 'string') {
            return data.error;
        }
        if (Array.isArray(data.errors) && typeof data.errors[0]?.detail === 'string') {
            return data.errors[0].detail;
        }
    }

    return typeof data === 'string' ? data.slice(0, 200) : '';
};

const STORAGE_PATTERN = /(disk (limit|space)|no space left|insufficient storage|quota|not enough (disk|space))/i;

/**
 * Turns whatever axios (or our own flow) threw into something specific the user can act on.
 *
 * The messages that matter most come from Wings itself:
 *  - 404 "The requested resource was not found on this server." is NOT a missing file. Wings answers it
 *    when the one-time upload token was already used (a replayed request), was revoked, or the server is
 *    not loaded on that node. Retrying with a new token fixes it, so it is reported as such.
 *  - 400 "File X is larger than the maximum file upload size of N MB." is the node-side limit.
 */
export const classifyUploadError = (error: any, phase: UploadPhase = 'upload'): ClassifiedUploadError => {
    if (error instanceof UploadFlowError) {
        return error.info;
    }

    if (error instanceof UploadStalledError) {
        return {
            kind: 'stalled',
            retryable: true,
            message: translateUiText(
                'The upload stopped receiving data for {{seconds}} seconds, so it was restarted automatically.',
                { seconds: error.seconds }
            ),
        };
    }

    if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || error?.name === 'AbortError') {
        return { kind: 'canceled', retryable: false, message: translateUiText('Upload canceled.') };
    }

    const status: number | undefined = error?.response?.status;
    const detail = wingsMessage(error);

    if (!error?.response) {
        if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
            return {
                kind: 'network',
                retryable: true,
                message: translateUiText('The connection to the node timed out during the upload.'),
            };
        }

        return {
            kind: 'network',
            retryable: true,
            message: translateUiText(
                'The connection to the node was lost during the upload. Check your internet connection; the upload is retried automatically.'
            ),
        };
    }

    if (status === 413) {
        return {
            kind: 'proxy_limit',
            retryable: false,
            status,
            message: translateUiText(
                'A proxy or firewall between you and the node rejected the file for being too large (HTTP 413).'
            ),
        };
    }

    if (STORAGE_PATTERN.test(detail) || status === 507) {
        return {
            kind: 'insufficient_storage',
            retryable: false,
            status,
            message: translateUiText('There is not enough storage space on this server to finish the upload.'),
        };
    }

    const tooLarge = /larger than the maximum file upload size of (\d+) MB/i.exec(detail);
    if (tooLarge) {
        return {
            kind: 'too_large',
            retryable: false,
            status,
            message: translateUiText(
                'The file is larger than the maximum upload size allowed by this node ({{limit}} MB).',
                { limit: tooLarge[1] }
            ),
        };
    }

    if (phase === 'sign' && (status === 401 || status === 403 || status === 404)) {
        return {
            kind: 'forbidden',
            retryable: false,
            status,
            message: translateUiText('You do not have permission to upload files to this server.'),
        };
    }

    // Wings: invalid/expired/used/revoked upload token, or the server is not loaded on the node.
    if (phase === 'upload' && (status === 404 || status === 401 || status === 403)) {
        return {
            kind: 'token_rejected',
            retryable: true,
            status,
            message: translateUiText(
                'The node rejected the upload authorization (expired, already used or revoked). A new authorization is requested automatically.'
            ),
        };
    }

    if (status && status >= 500) {
        return {
            kind: 'server',
            retryable: true,
            status,
            message: translateUiText('The node returned an error (HTTP {{status}}) while receiving the file.', {
                status,
            }),
        };
    }

    if (status === 400 || status === 422) {
        return {
            kind: 'bad_request',
            retryable: false,
            status,
            message: translateUiText('The node could not process the upload: {{detail}}', {
                detail: detail || `HTTP ${status}`,
            }),
        };
    }

    return {
        kind: 'unknown',
        retryable: false,
        status,
        message: translateUiText('Unexpected upload error: {{detail}}', {
            detail: detail || error?.message || `HTTP ${status ?? '?'}`,
        }),
    };
};
