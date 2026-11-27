import { translateUiText } from '@/i18n/uiTranslations';
import tw from 'twin.macro';
import { Button } from '@/components/elements/button/index';
import React, { useEffect, useRef } from 'react';
import { ModalMask } from '@/components/elements/Modal';
import Fade from '@/components/elements/Fade';
import useEventListener from '@/plugins/useEventListener';
import { useFlashKey } from '@/plugins/useFlash';
import useFileManagerSwr from '@/plugins/useFileManagerSwr';
import { ServerContext } from '@/state/server';
import { WithClassname } from '@/components/types';
import Portal from '@/components/elements/Portal';
import { CloudUploadIcon } from '@heroicons/react/outline';
import { useSignal } from '@preact/signals-react';
import { usePermissions } from '@/plugins/usePermissions';
import { uploadAuto } from '@/components/server/files/upload/chunked/uploadStrategy';
import { MAX_PARALLEL_UPLOADS, runPool } from '@/components/server/files/upload/queue';

function isFileOrDirectory(event: DragEvent): boolean {
    if (!event.dataTransfer?.types) {
        return false;
    }

    return event.dataTransfer.types.some((value) => value.toLowerCase() === 'files');
}

export default ({ className }: WithClassname) => {
    const fileUploadInput = useRef<HTMLInputElement>(null);

    const visible = useSignal(false);
    const timeouts = useSignal<NodeJS.Timeout[]>([]);

    const { mutate } = useFileManagerSwr();
    const { addError, clearFlashes } = useFlashKey('files');
    // Uploading under a temporary name and renaming on success needs update (rename) permission. Without it
    // the legacy direct upload is used, which keeps working for users that only have file.create.
    const [canUpdate, canDelete] = usePermissions(['file.update', 'file.delete']);

    const uuid = ServerContext.useStoreState((state) => state.server.data!.uuid);
    const directory = ServerContext.useStoreState((state) => state.files.directory);
    const { removeFileUpload, pushFileUpload, updateFileUpload } = ServerContext.useStoreActions(
        (actions) => actions.files
    );
    const store = ServerContext.useStore();
    const hasFailed = (name: string) => store.getState().files.uploads[name]?.status === 'error';

    useEventListener(
        'dragenter',
        (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isFileOrDirectory(e)) {
                visible.value = true;
            }
        },
        { capture: true }
    );

    useEventListener('dragexit', () => (visible.value = false), { capture: true });

    useEventListener('keydown', () => (visible.value = false));

    useEffect(() => {
        return () => timeouts.value.forEach(clearTimeout);
    }, []);

    const onFileSubmission = (files: FileList) => {
        clearFlashes();
        const list = Array.from(files);
        if (list.some((file) => !file.type && (!file.size || file.size === 4096))) {
            return addError(translateUiText('Folder uploads are not supported.'), translateUiText('Error'));
        }

        // The directory is captured now so navigating elsewhere while files are queued does not change
        // where they end up.
        const target = directory;
        const jobs = list.map((file) => {
            const controller = new AbortController();
            pushFileUpload({
                name: file.name,
                data: { abort: controller, loaded: 0, total: file.size, status: 'queued', speed: 0, eta: null },
            });

            return { file, controller };
        });

        runPool(jobs, MAX_PARALLEL_UPLOADS, async ({ file, controller }) => {
            // Canceled while still waiting in the queue.
            if (controller.signal.aborted) {
                return;
            }

            try {
                await uploadAuto({
                    uuid,
                    directory: target,
                    blob: file,
                    signal: controller.signal,
                    staged: canUpdate,
                    canReplace: canDelete,
                    onUpdate: (patch) => updateFileUpload({ name: file.name, patch }),
                });

                timeouts.value.push(setTimeout(() => removeFileUpload(file.name), 1500));
                mutate();
            } catch (error) {
                // uploadFile already recorded the specific reason on the entry; canceled ones just vanish.
                if (controller.signal.aborted) {
                    removeFileUpload(file.name);
                }
            }
        }).then(() => {
            mutate();

            const failed = jobs.filter(({ file, controller }) => !controller.signal.aborted && hasFailed(file.name));
            if (failed.length > 0) {
                addError(
                    translateUiText('{{count}} file(s) failed to upload. Open the upload list for details.', {
                        count: failed.length,
                    }),
                    translateUiText('Upload failed')
                );
            }
        });
    };

    return (
        <>
            <Portal>
                <Fade appear in={visible.value} timeout={75} key={'upload_modal_mask'} unmountOnExit>
                    <ModalMask
                        onClick={() => (visible.value = false)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();

                            visible.value = false;
                            if (!e.dataTransfer?.files.length) return;

                            onFileSubmission(e.dataTransfer.files);
                        }}
                    >
                        <div className={'w-full flex items-center justify-center pointer-events-none'}>
                            <div
                                className={
                                    'flex items-center space-x-4 bg-black w-full ring-4 ring-blue-200 ring-opacity-60 rounded p-6 mx-10 max-w-sm'
                                }
                            >
                                <CloudUploadIcon className={'w-10 h-10 flex-shrink-0'} />
                                <p className={'font-header flex-1 text-lg text-neutral-100 text-center'}>
                                    {translateUiText('Drag and drop files to upload.')}
                                </p>
                            </div>
                        </div>
                    </ModalMask>
                </Fade>
            </Portal>
            <input
                type={'file'}
                ref={fileUploadInput}
                css={tw`hidden`}
                onChange={(e) => {
                    if (!e.currentTarget.files) return;

                    onFileSubmission(e.currentTarget.files);
                    if (fileUploadInput.current) {
                        fileUploadInput.current.files = null;
                    }
                }}
                multiple
            />
            <Button className={className} onClick={() => fileUploadInput.current && fileUploadInput.current.click()}>
                {translateUiText('Upload')}
            </Button>
        </>
    );
};
