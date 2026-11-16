import React, { FormEvent, useEffect, useState } from 'react';
import Button from '@/components/elements/Button';
import Input from '@/components/elements/Input';
import { httpErrorToHuman } from '@/api/http';
import { getWorkshopCollection, WorkshopCollectionResult, WorkshopItem } from '@/api/server/howtoo';
import { translateUiText } from '@/i18n/uiTranslations';

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
    const [collectionLink, setCollectionLink] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const options = preview?.items || [];
    const toAdd = options.filter((item) => !configured.has(item.workshopId) && item.modIds.length > 0);
    const pending = options.filter((item) => item.modIdPending).length;
    const missing = options.filter(
        (item) => !configured.has(item.workshopId) && !item.modIdPending && !item.modIds.length
    ).length;

    useEffect(() => {
        if (!pending || error) return;
        let active = true;
        const timer = window.setTimeout(async () => {
            try {
                const result = await getWorkshopCollection(uuid, collectionLink);
                if (active) setPreview(result);
            } catch (cause) {
                if (active) setError(httpErrorToHuman(cause));
            }
        }, 6000);

        return () => {
            active = false;
            window.clearTimeout(timer);
        };
    }, [uuid, collectionLink, preview, pending, error]);

    const previewCollection = async (event: FormEvent) => {
        event.preventDefault();
        if (!link.trim() || loading) return;
        setLoading(true);
        setError('');
        setNotice('');
        setPreview(null);
        try {
            const result = await getWorkshopCollection(uuid, link.trim());
            setCollectionLink(link.trim());
            setPreview(result);
        } catch (cause) {
            setError(httpErrorToHuman(cause));
        } finally {
            setLoading(false);
        }
    };

    const apply = () => {
        if (!toAdd.length || pending) return;
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
                    'Cole o link de uma coleção pública de Project Zomboid para detectar automaticamente os Workshop IDs e Mod IDs.'
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
                    {!!pending && (
                        <p role='status' style={{ color: 'var(--hts-ink-muted)', fontSize: '.75rem' }}>
                            {translateUiText('Lendo os arquivos de {{count}} itens do Workshop…', { count: pending })}
                        </p>
                    )}
                    {!!missing && (
                        <p style={{ color: '#fbbf24', fontSize: '.75rem', marginBottom: '.55rem' }}>
                            {translateUiText('Não foi possível detectar os Mod IDs de {{count}} itens.', {
                                count: missing,
                            })}
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
                                            : item.modIdPending
                                            ? translateUiText('Detectando Mod IDs')
                                            : translateUiText('Mod IDs indisponíveis')}
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
                            </div>
                        ))}
                    </div>
                    <Button
                        type='button'
                        disabled={!toAdd.length || !!pending}
                        onClick={apply}
                        style={{ marginTop: '.75rem' }}
                    >
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
