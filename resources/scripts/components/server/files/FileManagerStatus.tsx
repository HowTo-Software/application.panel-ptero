import { translateUiText } from '@/i18n/uiTranslations';
import React, { useContext, useEffect } from 'react';
import { ServerContext } from '@/state/server';
import { CloudUploadIcon, ExclamationCircleIcon, XIcon } from '@heroicons/react/solid';
import asDialog from '@/hoc/asDialog';
import { Dialog, DialogWrapperContext } from '@/components/elements/dialog';
import { Button } from '@/components/elements/button/index';
import Tooltip from '@/components/elements/tooltip/Tooltip';
import Code from '@/components/elements/Code';
import { useSignal } from '@preact/signals-react';
import { FileUploadData } from '@/state/server/files';
import { formatBytes, formatEta, formatSpeed } from '@/components/server/files/upload/format';

const svgProps = {
    cx: 16,
    cy: 16,
    r: 14,
    strokeWidth: 3,
    fill: 'none',
    stroke: 'currentColor',
};

const Spinner = ({ progress, className }: { progress: number; className?: string }) => (
    <svg viewBox={'0 0 32 32'} className={className}>
        <circle {...svgProps} className={'opacity-25'} />
        <circle
            {...svgProps}
            stroke={'white'}
            strokeDasharray={28 * Math.PI}
            className={'rotate-[-90deg] origin-[50%_50%] transition-[stroke-dashoffset] duration-300'}
            style={{ strokeDashoffset: ((100 - progress) / 100) * 28 * Math.PI }}
        />
    </svg>
);

const percent = (loaded: number, total: number): number =>
    total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 100;

const isActive = (file: FileUploadData): boolean => file.status !== 'error';

const statusLine = (file: FileUploadData): string => {
    switch (file.status) {
        case 'queued':
            return translateUiText('Queued');
        case 'retrying':
            return translateUiText('Retrying in {{seconds}}s (attempt {{attempt}} of {{max}})', {
                seconds: Math.ceil((file.retryInMs ?? 0) / 1000),
                attempt: Math.min((file.attempt ?? 1) + 1, file.maxAttempts ?? 1),
                max: file.maxAttempts ?? 1,
            });
        case 'verifying':
            return translateUiText('Verifying file…');
        case 'finalizing':
            return translateUiText('Finishing…');
        case 'done':
            return translateUiText('Completed');
        case 'error':
            return translateUiText('Failed');
        default:
            return `${formatSpeed(file.speed ?? 0)} · ${translateUiText('{{time}} remaining', {
                time: formatEta(file.eta),
            })}${
                (file.attempt ?? 1) > 1
                    ? ` · ${translateUiText('Attempt {{attempt}} of {{max}}', {
                          attempt: file.attempt ?? 1,
                          max: file.maxAttempts ?? 1,
                      })}`
                    : ''
            }`;
    }
};

const FileUploadList = () => {
    const { close } = useContext(DialogWrapperContext);
    const cancelFileUpload = ServerContext.useStoreActions((actions) => actions.files.cancelFileUpload);
    const clearFileUploads = ServerContext.useStoreActions((actions) => actions.files.clearFileUploads);
    const uploads = ServerContext.useStoreState((state) =>
        Object.entries(state.files.uploads).sort(([a], [b]) => a.localeCompare(b))
    );

    const running = uploads.map(([, file]) => file).filter(isActive);
    const totalSpeed = running.reduce((sum, file) => sum + (file.status === 'uploading' ? file.speed ?? 0 : 0), 0);
    const loaded = running.reduce((sum, file) => sum + file.loaded, 0);
    const total = running.reduce((sum, file) => sum + file.total, 0);

    return (
        <div className={'space-y-2 mt-6'}>
            {running.length > 1 && (
                <p className={'text-sm text-gray-300'} aria-live={'polite'}>
                    {`${translateUiText('Total')}: ${percent(loaded, total)}% · ${formatBytes(loaded)} / ${formatBytes(
                        total
                    )} · ${formatSpeed(totalSpeed)} · ${translateUiText('{{time}} remaining', {
                        time: formatEta(totalSpeed > 0 ? (total - loaded) / totalSpeed : null),
                    })}`}
                </p>
            )}
            {uploads.map(([name, file]) => (
                <div key={name} className={'bg-gray-700 p-3 rounded'}>
                    <div className={'flex items-center space-x-3'}>
                        <Tooltip content={`${percent(file.loaded, file.total)}%`} placement={'left'}>
                            <div className={'flex-shrink-0'}>
                                {file.status === 'error' ? (
                                    <ExclamationCircleIcon className={'w-6 h-6 text-red-400'} />
                                ) : (
                                    <Spinner progress={percent(file.loaded, file.total)} className={'w-6 h-6'} />
                                )}
                            </div>
                        </Tooltip>
                        <Code className={'flex-1 truncate'}>{name}</Code>
                        <button
                            // Finishing swaps file names on the server and must not be interrupted halfway.
                            disabled={file.status === 'finalizing'}
                            onClick={cancelFileUpload.bind(this, name)}
                            title={translateUiText(file.status === 'error' ? 'Dismiss' : 'Cancel')}
                            className={
                                'text-gray-500 hover:text-gray-200 transition-colors duration-75 disabled:opacity-30'
                            }
                        >
                            <XIcon className={'w-5 h-5'} />
                        </button>
                    </div>
                    <div className={'mt-1 ml-9 text-xs text-gray-300'}>
                        <span>
                            {percent(file.loaded, file.total)}% · {formatBytes(file.loaded)} / {formatBytes(file.total)}
                        </span>
                        {file.status !== 'error' && <span> · {statusLine(file)}</span>}
                    </div>
                    {file.mode === 'chunked' && file.status !== 'error' && (
                        <div className={'mt-1 ml-9 text-xs text-gray-400'}>
                            {translateUiText('Chunked upload')}
                            {file.connections
                                ? ` · ${translateUiText('{{count}} parallel connections', { count: file.connections })}`
                                : ''}
                            {file.resumedFrom
                                ? ` · ${translateUiText('Resumed: {{size}} were already on the server', {
                                      size: formatBytes(file.resumedFrom),
                                  })}`
                                : ''}
                        </div>
                    )}
                    {file.status === 'done' && file.sha256 && (
                        <div className={'mt-1 ml-9 text-xs text-gray-400 truncate'} title={file.sha256}>
                            {`SHA-256: ${file.sha256}`}
                        </div>
                    )}
                    {file.error && (
                        <p
                            className={`mt-1 ml-9 text-xs ${
                                file.status === 'error' ? 'text-red-300' : 'text-yellow-300'
                            }`}
                            role={file.status === 'error' ? 'alert' : undefined}
                        >
                            {file.error}
                        </p>
                    )}
                </div>
            ))}
            <Dialog.Footer>
                <Button.Danger variant={Button.Variants.Secondary} onClick={() => clearFileUploads()}>
                    {translateUiText('Cancel Uploads')}
                </Button.Danger>
                <Button.Text onClick={close}>{translateUiText('Close')}</Button.Text>
            </Dialog.Footer>
        </div>
    );
};

const FileUploadListDialog = asDialog({
    title: translateUiText('File Uploads'),
    description: translateUiText('The following files are being uploaded to your server.'),
})(FileUploadList);

export default () => {
    const open = useSignal(false);

    const count = ServerContext.useStoreState((state) => Object.keys(state.files.uploads).length);
    const failed = ServerContext.useStoreState(
        (state) => Object.values(state.files.uploads).filter((file) => file.status === 'error').length
    );
    const progress = ServerContext.useStoreState((state) => ({
        uploaded: Object.values(state.files.uploads).reduce((count, file) => count + file.loaded, 0),
        total: Object.values(state.files.uploads).reduce((count, file) => count + file.total, 0),
    }));

    useEffect(() => {
        if (count === 0) {
            open.value = false;
        }
    }, [count]);

    // Leaving the page aborts every in-flight upload and discards the partial data, so warn first.
    const inFlight = count - failed;
    useEffect(() => {
        if (inFlight <= 0) {
            return;
        }

        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = '';
        };

        window.addEventListener('beforeunload', warn);

        return () => window.removeEventListener('beforeunload', warn);
    }, [inFlight > 0]);

    return (
        <>
            {count > 0 && (
                <Tooltip
                    content={
                        failed > 0
                            ? translateUiText('Upload failed')
                            : `${count} ${translateUiText(
                                  count === 1
                                      ? 'file is uploading, click to view'
                                      : 'files are uploading, click to view'
                              )}`
                    }
                >
                    <button
                        className={'flex items-center justify-center w-10 h-10'}
                        onClick={() => (open.value = true)}
                    >
                        <Spinner
                            progress={progress.total > 0 ? (progress.uploaded / progress.total) * 100 : 100}
                            className={`w-8 h-8 ${failed > 0 ? 'text-red-400' : ''}`}
                        />
                        <CloudUploadIcon className={`h-3 absolute mx-auto ${failed > 0 ? '' : 'animate-pulse'}`} />
                    </button>
                </Tooltip>
            )}
            <FileUploadListDialog open={open.value} onClose={() => (open.value = false)} />
        </>
    );
};
