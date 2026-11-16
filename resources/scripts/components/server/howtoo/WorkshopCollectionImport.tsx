import React, { FormEvent, useMemo, useState } from 'react';
import Button from '@/components/elements/Button';
import Input from '@/components/elements/Input';
import { httpErrorToHuman } from '@/api/http';
import {
    getWorkshopCollection,
    resolveWorkshopItem,
    WorkshopCollectionResult,
    WorkshopItem,
} from '@/api/server/howtoo';
import { translateUiText } from '@/i18n/uiTranslations';
import { uniqueWorkshopValues } from './workshopSelection';

interface Props {
    uuid: string;
    configured: Set<string>;
    onImport: (items: WorkshopItem[]) => boolean;
}

/**
 * Collection import only prepares unsaved WorkshopItems and Mods changes.
 * Never writes the PZ INI; the surrounding editor owns the Save action.
 */
export default function WorkshopCollectionImport({ uuid, configured, onImport }: Props) {
    const [link, setLink] = useState('');
    const [preview, setPreview] = useState<WorkshopCollectionResult | null>(null);
    const [manual, setManual] = useState<Record<string, string>>({});
    const [resolved, setResolved] = useState<Record<string, WorkshopItem>>({});
    const [resolving, setResolving] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const options = useMemo(
        () =>
            (preview?.items || []).map((original) => {
                const item = resolved[original.workshopId] || original;
                const exactIds = uniqueWorkshopValues((manual[item.workshopId] || '').split(/[;,]/)).filter((id) =>
                    /^[A-Za-z0-9_.-]{1,128}$/.test(id)
                );
                return item.modIds.length ? item : { ...item, modIds: exactIds };
            }),
        [preview, manual, resolved]
    );
    const toAdd = options.filter((item) => !configured.has(item.workshopId) && item.modIds.length > 0);
    const missing = options.filter((item) => item.modIds.length === 0);

    const previewCollection = async (event: FormEvent) => {
        event.preventDefault();
        if (!link.trim() || loading) return;
        setLoading(true);
        setError('');
        setNotice('');
        setPreview(null);
        setManual({});
        setResolved({});
        try {
            const result = await getWorkshopCollection(uuid, link.trim());
            setPreview(result);
        } catch (cause) {
            setError(httpErrorToHuman(cause));
        } finally {
            setLoading(false);
        }
    };

    const tryResolve = async (item: WorkshopItem) => {
        if (resolving) return;
        setResolving(item.workshopId);
        setError('');
        try {
            const updated = await resolveWorkshopItem(uuid, item.workshopId);
            if (updated.modIds.length) {
                setResolved((current) => ({ ...current, [item.workshopId]: updated }));
            } else {
                setError(translateUiText('Steam não informou o Mod ID deste item. Informe o valor exato do mod.info.'));
            }
        } catch (cause) {
            setError(httpErrorToHuman(cause));
        } finally {
            setResolving(null);
        }
    };

    const apply = () => {
        if (!toAdd.length) return;
        if (!onImport(toAdd)) {
            setError(
                translateUiText(
                    'A coleção excede o limite de 500 Workshop IDs ou Mod IDs. Remova alguns itens antes de importar.'
                )
            );
            return;
        }
        setNotice(
            translateUiText(
                'Mods da coleção adicionados às alterações pendentes. Clique em Salvar para aplicar no servidor.'
            )
        );
    };

    return (
        <section
            aria-label={translateUiText('Importar coleção do Steam Workshop')}
            style={{
                marginTop: '.9rem',
                padding: '1rem',
                borderRadius: '.55rem',
                border: '1px solid var(--hts-border)',
                background: 'var(--hts-surface-soft)',
            }}
        >
            <h3 style={{ color: 'var(--hts-ink)', fontSize: '.95rem', fontWeight: 600 }}>
                {translateUiText('Importar coleção do Steam Workshop')}
            </h3>
            <p style={{ color: 'var(--hts-ink-muted)', fontSize: '.77rem', margin: '.35rem 0 .7rem' }}>
                {translateUiText(
                    'Cole o link de uma coleção pública de Project Zomboid. Workshop IDs e Mod IDs serão coletados automaticamente quando disponíveis.'
                )}
            </p>
            <form
                onSubmit={(event) => void previewCollection(event)}
                style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}
            >
                <Input
                    aria-label={translateUiText('Link da coleção do Steam')}
                    value={link}
                    onChange={(event) => setLink(event.currentTarget.value)}
                    placeholder='https://steamcommunity.com/sharedfiles/filedetails/?id=...'
                    style={{ minWidth: '16rem', flex: 1 }}
                    maxLength={300}
                />
                <Button type='submit' disabled={loading || !link.trim()} isLoading={loading}>
                    {translateUiText('Buscar coleção')}
                </Button>
            </form>
            {error && (
                <p role='alert' style={{ color: '#fca5a5', marginTop: '.7rem', fontSize: '.8rem' }}>
                    {error}
                </p>
            )}
            {notice && <p style={{ color: '#86efac', marginTop: '.7rem', fontSize: '.8rem' }}>{notice}</p>}
            {preview && (
                <div style={{ marginTop: '.85rem' }}>
                    <strong style={{ color: 'var(--hts-ink)', fontSize: '.82rem' }}>{preview.name}</strong>
                    <p style={{ color: 'var(--hts-ink-muted)', fontSize: '.75rem', margin: '.4rem 0' }}>
                        {preview.total} {translateUiText('itens na coleção')} · {options.length}{' '}
                        {translateUiText('itens de Project Zomboid disponíveis')} · {toAdd.length}{' '}
                        {translateUiText('prontos para adicionar')}
                    </p>
                    {!!preview.unavailableIds.length && (
                        <p style={{ color: '#fbbf24', fontSize: '.75rem', marginBottom: '.55rem' }}>
                            {preview.unavailableIds.length}{' '}
                            {translateUiText('itens privados, removidos ou incompatíveis foram ignorados.')}
                        </p>
                    )}
                    {!!missing.length && (
                        <p style={{ color: '#fbbf24', fontSize: '.75rem', marginBottom: '.55rem' }}>
                            {missing.length}{' '}
                            {translateUiText(
                                'itens não informam um Mod ID. Informe o ID exato do mod.info abaixo para incluí-los.'
                            )}
                        </p>
                    )}
                    <div style={{ maxHeight: '21rem', overflowY: 'auto', display: 'grid', gap: '.4rem' }}>
                        {options.map((item) => (
                            <div
                                key={item.workshopId}
                                style={{
                                    border: '1px solid var(--hts-border)',
                                    borderRadius: '.35rem',
                                    padding: '.45rem .55rem',
                                    color: 'var(--hts-ink)',
                                    fontSize: '.77rem',
                                }}
                            >
                                <div
                                    style={{
                                        display: 'flex',
                                        flexWrap: 'wrap',
                                        gap: '.5rem',
                                        justifyContent: 'space-between',
                                    }}
                                >
                                    <span style={{ overflowWrap: 'anywhere' }}>
                                        <strong>{item.name}</strong> · {item.workshopId}
                                    </span>
                                    <span
                                        style={{
                                            color: configured.has(item.workshopId)
                                                ? '#86efac'
                                                : item.modIds.length
                                                ? '#a5b4fc'
                                                : '#fbbf24',
                                        }}
                                    >
                                        {configured.has(item.workshopId)
                                            ? translateUiText('Já configurado')
                                            : item.modIds.length
                                            ? translateUiText('Pronto')
                                            : translateUiText('Mod ID pendente')}
                                    </span>
                                </div>
                                {!!item.modIds.length && (
                                    <p
                                        style={{
                                            marginTop: '.25rem',
                                            color: 'var(--hts-ink-muted)',
                                            overflowWrap: 'anywhere',
                                        }}
                                    >
                                        Mod ID: {item.modIds.join('; ')}
                                    </p>
                                )}
                                {!item.modIds.length && !configured.has(item.workshopId) && (
                                    <>
                                        <Button
                                            type='button'
                                            isSecondary
                                            size='xsmall'
                                            disabled={!!resolving}
                                            isLoading={resolving === item.workshopId}
                                            onClick={() => void tryResolve(item)}
                                            style={{ marginTop: '.35rem' }}
                                        >
                                            {translateUiText('Tentar detectar Mod ID')}
                                        </Button>
                                        <Input
                                            aria-label={translateUiText('Mod IDs para ') + item.name}
                                            value={manual[item.workshopId] || ''}
                                            onChange={(event) =>
                                                setManual((current) => ({
                                                    ...current,
                                                    [item.workshopId]: event.currentTarget.value,
                                                }))
                                            }
                                            placeholder={translateUiText('Mod IDs exatos, separados por ;')}
                                            style={{ width: '100%', marginTop: '.35rem' }}
                                        />
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                    <Button type='button' disabled={!toAdd.length} onClick={apply} style={{ marginTop: '.75rem' }}>
                        {translateUiText('Adicionar {{count}} mods à configuração pendente', { count: toAdd.length })}
                    </Button>
                    <p style={{ color: 'var(--hts-ink-muted)', fontSize: '.72rem', marginTop: '.45rem' }}>
                        {translateUiText(
                            'Nenhum arquivo do servidor é alterado até clicar em Salvar ou Salvar e Reiniciar.'
                        )}
                    </p>
                </div>
            )}
        </section>
    );
}
