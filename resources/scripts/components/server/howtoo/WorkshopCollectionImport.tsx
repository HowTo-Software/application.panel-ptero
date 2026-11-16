import React, { FormEvent, useEffect, useState } from 'react';
import Button from '@/components/elements/Button';
import Input from '@/components/elements/Input';
import { httpErrorToHuman } from '@/api/http';
import { getWorkshopCollection, WorkshopCollectionResult, WorkshopItem } from '@/api/server/howtoo';
import { translateUiText } from '@/i18n/uiTranslations';
import { parseManualModIds, withManualModIds, workshopModIdReasonText } from './workshopSelection';

interface Props {
    uuid: string;
    configured: Set<string>;
    onImport: (items: WorkshopItem[]) => boolean;
}

const POLL_INTERVAL_MS = 6000;
/** Stop re-polling pending items after ~3 minutes; they can still be imported and resolved on save. */
const MAX_POLLS = 30;

/**
 * Collection import only prepares unsaved WorkshopItems and Mods changes.
 * Never writes the PZ INI; the surrounding editor owns the Save action.
 *
 * Every item can be imported: an item whose Mod ID was not detected is added to
 * WorkshopItems (so the game server downloads it) with an optional typed Mod ID,
 * and the server resolves it again when the configuration is saved.
 */
export default function WorkshopCollectionImport({ uuid, configured, onImport }: Props) {
    const [link, setLink] = useState('');
    const [preview, setPreview] = useState<WorkshopCollectionResult | null>(null);
    const [collectionLink, setCollectionLink] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [excluded, setExcluded] = useState<Set<string>>(new Set());
    const [manual, setManual] = useState<Record<string, string>>({});
    const [polls, setPolls] = useState(0);

    const options = preview?.items || [];
    const available = options.filter((item) => !configured.has(item.workshopId));
    const toAdd = available
        .filter((item) => !excluded.has(item.workshopId))
        .map((item) => withManualModIds(item, parseManualModIds(manual[item.workshopId] || '')));
    const pending = options.filter((item) => item.modIdPending).length;
    const missing = available.filter((item) => !item.modIdPending && !item.modIds.length).length;
    const withoutIds = toAdd.filter((item) => !item.modIds.length).length;

    useEffect(() => {
        if (!pending || error || polls >= MAX_POLLS) return;
        let active = true;
        const timer = window.setTimeout(async () => {
            try {
                const result = await getWorkshopCollection(uuid, collectionLink);
                if (active) {
                    setPreview(result);
                    setPolls((value) => value + 1);
                }
            } catch (cause) {
                if (active) setError(httpErrorToHuman(cause));
            }
        }, POLL_INTERVAL_MS);

        return () => {
            active = false;
            window.clearTimeout(timer);
        };
    }, [uuid, collectionLink, preview, pending, error, polls]);

    const previewCollection = async (event: FormEvent) => {
        event.preventDefault();
        if (!link.trim() || loading) return;
        setLoading(true);
        setError('');
        setNotice('');
        setPreview(null);
        setExcluded(new Set());
        setManual({});
        setPolls(0);
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

    const toggle = (workshopId: string) =>
        setExcluded((current) => {
            const next = new Set(current);
            next.has(workshopId) ? next.delete(workshopId) : next.add(workshopId);
            return next;
        });

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
            withoutIds
                ? translateUiText(
                      'Mods da coleção adicionados às alterações pendentes. {{count}} sem Mod ID serão resolvidos ao salvar ou depois que o servidor baixá-los.',
                      { count: withoutIds }
                  )
                : translateUiText(
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
                        {translateUiText('selecionados para adicionar')}
                    </p>
                    {!!preview.unavailableIds.length && (
                        <p style={{ color: '#fbbf24', fontSize: '.75rem', marginBottom: '.55rem' }}>
                            {preview.unavailableIds.length}{' '}
                            {translateUiText('itens privados, removidos ou incompatíveis foram ignorados.')}
                        </p>
                    )}
                    {!!pending && (
                        <p role='status' style={{ color: 'var(--hts-ink-muted)', fontSize: '.75rem' }}>
                            {polls >= MAX_POLLS
                                ? translateUiText(
                                      'A leitura dos arquivos de {{count}} itens está demorando. Você pode importar assim mesmo: eles serão resolvidos ao salvar.',
                                      { count: pending }
                                  )
                                : translateUiText('Lendo os arquivos de {{count}} itens do Workshop…', {
                                      count: pending,
                                  })}
                        </p>
                    )}
                    {!!missing && (
                        <p style={{ color: '#fbbf24', fontSize: '.75rem', marginBottom: '.55rem' }}>
                            {translateUiText(
                                'Não foi possível detectar os Mod IDs de {{count}} itens. Eles podem ser importados mesmo assim: digite o Mod ID ou deixe o painel ler o mod.info depois que o servidor baixar o mod.',
                                { count: missing }
                            )}
                        </p>
                    )}
                    <div style={{ maxHeight: '21rem', overflowY: 'auto', display: 'grid', gap: '.4rem' }}>
                        {options.map((item) => {
                            const isConfigured = configured.has(item.workshopId);
                            const checked = !isConfigured && !excluded.has(item.workshopId);
                            const unresolved = !item.modIds.length && !item.modIdPending;
                            return (
                                <div
                                    key={item.workshopId}
                                    style={{
                                        border: '1px solid var(--hts-border)',
                                        borderRadius: '.35rem',
                                        padding: '.45rem .55rem',
                                        color: 'var(--hts-ink)',
                                        fontSize: '.77rem',
                                        opacity: isConfigured || checked ? 1 : 0.6,
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
                                        <label
                                            style={{
                                                display: 'flex',
                                                gap: '.45rem',
                                                alignItems: 'flex-start',
                                                overflowWrap: 'anywhere',
                                                cursor: isConfigured ? 'default' : 'pointer',
                                            }}
                                        >
                                            <input
                                                type='checkbox'
                                                checked={isConfigured || checked}
                                                disabled={isConfigured}
                                                onChange={() => toggle(item.workshopId)}
                                                style={{ marginTop: '.15rem' }}
                                            />
                                            <span>
                                                <strong>{item.name}</strong> · {item.workshopId}
                                            </span>
                                        </label>
                                        <span
                                            style={{
                                                color: isConfigured
                                                    ? '#86efac'
                                                    : item.modIds.length
                                                    ? '#a5b4fc'
                                                    : '#fbbf24',
                                            }}
                                        >
                                            {isConfigured
                                                ? translateUiText('Já configurado')
                                                : item.modIds.length
                                                ? translateUiText('Pronto')
                                                : item.modIdPending
                                                ? translateUiText('Detectando Mod IDs')
                                                : translateUiText('Mod ID não detectado')}
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
                                    {unresolved && !isConfigured && (
                                        <div style={{ marginTop: '.35rem' }}>
                                            <p style={{ color: 'var(--hts-ink-muted)', fontSize: '.7rem' }}>
                                                {translateUiText('Motivo: {{reason}}.', {
                                                    reason: translateUiText(workshopModIdReasonText(item.modIdReason)),
                                                })}{' '}
                                                <a
                                                    href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(
                                                        item.workshopId
                                                    )}`}
                                                    target='_blank'
                                                    rel='noreferrer'
                                                >
                                                    {translateUiText('Abrir no Steam ↗')}
                                                </a>
                                            </p>
                                            <Input
                                                aria-label={translateUiText('Mod ID do item {{id}}', {
                                                    id: item.workshopId,
                                                })}
                                                value={manual[item.workshopId] || ''}
                                                disabled={!checked}
                                                onChange={(event) => {
                                                    const value = event.currentTarget.value;
                                                    setManual((current) => ({ ...current, [item.workshopId]: value }));
                                                }}
                                                placeholder={translateUiText('Mod ID (opcional, separados por ;)')}
                                                style={{ marginTop: '.3rem', fontSize: '.72rem' }}
                                                maxLength={600}
                                            />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
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
