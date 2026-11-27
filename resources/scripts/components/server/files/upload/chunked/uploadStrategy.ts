import getUploadSession, { UploadSessionParams } from '@/api/server/files/getUploadSession';
import { classifyUploadError, UploadFlowError } from '@/components/server/files/upload/errors';
import { ChunkedDeps, ChunkedOptions, uploadChunked } from '@/components/server/files/upload/chunked/chunkedEngine';
import { listPending, removePending, savePending } from '@/components/server/files/upload/chunked/pending';
import { UploadSessionGrantResult } from '@/components/server/files/upload/chunked/types';
import { defaultWingsApi, sha256Hex } from '@/components/server/files/upload/chunked/wingsApi';
import { abortableSleep } from '@/components/server/files/upload/queue';
import { defaultDeps, uploadFile, UploadJob } from '@/components/server/files/upload/uploadEngine';

/**
 * Files smaller than this use the regular upload: a handful of requests of overhead is not worth it when there is
 * nothing to resume. Larger files use chunks when the node supports them.
 */
export const CHUNKED_MIN_BYTES = 8 * 1024 * 1024;

export interface StrategyDeps {
    getGrant(uuid: string, params: UploadSessionParams): Promise<UploadSessionGrantResult>;
    legacy(job: UploadJob): Promise<void>;
    chunked(
        job: UploadJob,
        grant: Extract<UploadSessionGrantResult, { supported: true }>,
        grantFor: () => Promise<UploadSessionGrantResult>
    ): Promise<void>;
}

const chunkedDeps = (uuid: string, getGrant: () => Promise<UploadSessionGrantResult>): ChunkedDeps => ({
    getGrant,
    wings: defaultWingsApi,
    list: defaultDeps.list,
    digest: sha256Hex,
    sleep: abortableSleep,
    now: () => Date.now(),
    pending: {
        save: (entry) => savePending(uuid, entry),
        remove: (sessionId) => removePending(uuid, sessionId),
    },
});

export const defaultStrategyDeps = (options: ChunkedOptions = {}): StrategyDeps => ({
    getGrant: getUploadSession,
    legacy: (job) => uploadFile(job),
    chunked: (job, grant, grantFor) => uploadChunked(job, grant, chunkedDeps(job.uuid, grantFor), options),
});

export { listPending };

/**
 * Picks the best way to upload a file:
 *  - chunked, parallel and resumable when the node runs the HowTo.Software Wings and the file is big enough;
 *  - the regular (reliability-hardened) upload otherwise, so nodes running the original Wings keep working.
 *
 * If the panel cannot be asked (network blip) the regular upload is used. If it answers with a definite refusal
 * (no permission, file over the node limit) that is reported instead of silently trying something else.
 */
export const uploadAuto = async (job: UploadJob, deps: StrategyDeps = defaultStrategyDeps()): Promise<void> => {
    if (job.blob.size < CHUNKED_MIN_BYTES) {
        return deps.legacy(job);
    }

    const params: UploadSessionParams = {
        directory: job.directory,
        name: job.blob.name,
        size: job.blob.size,
        mtime: (job.blob as Partial<File>).lastModified ?? 0,
    };
    const grantFor = () => deps.getGrant(job.uuid, params);

    let grant: UploadSessionGrantResult;
    try {
        grant = await grantFor();
    } catch (error) {
        const info = classifyUploadError(error, 'sign');
        if (info.kind === 'forbidden' || info.kind === 'too_large' || info.kind === 'bad_request') {
            job.onUpdate({ status: 'error', error: info.message, errorKind: info.kind });
            throw new UploadFlowError(info);
        }

        return deps.legacy(job);
    }

    if (!grant.supported) {
        return deps.legacy(job);
    }

    try {
        return await deps.chunked(job, grant, grantFor);
    } catch (error) {
        // The node switched the feature off between the capability check and now: use the regular upload.
        if (error instanceof UploadFlowError && error.info.kind === 'unsupported') {
            return deps.legacy(job);
        }

        throw error;
    }
};
