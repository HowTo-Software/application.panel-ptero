import { translateUiText } from '@/i18n/uiTranslations';
import { getBrowserLocale } from '@/i18n/locale';
import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components/macro';
import ServerContentBlock from '@/components/elements/ServerContentBlock';
import Button from '@/components/elements/Button';
import Input from '@/components/elements/Input';
import Spinner from '@/components/elements/Spinner';
import Can from '@/components/elements/Can';
import { httpErrorToHuman } from '@/api/http';
import {
    getWorkshopConfiguration,
    resolveWorkshopItem,
    saveWorkshop,
    searchWorkshop,
    WorkshopBrowseMode,
    WorkshopConfiguration,
    WorkshopItem,
} from '@/api/server/howtoo';
import { ServerContext } from '@/state/server';
import { Muted } from './IntegrationStyles';
import WorkshopCollectionImport from './WorkshopCollectionImport';
import {
    addWorkshopSelection,
    appendWorkshopResults,
    hasWorkshopChanges,
    removeWorkshopSelection,
    uniqueWorkshopValues,
} from './workshopSelection';
import {
    Heading,
    PageGrid,
    Surface,
    WorkshopCards,
    WorkshopDetails,
    WorkshopFilters,
    WorkshopSkeletonGrid,
} from './WorkshopCatalog';

const MainColumn = styled.main`
    min-width: 0;
    padding-bottom: 6.5rem;
`;
const Cover = styled.div`
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.85rem;
    padding: 0.3rem 0 0.85rem;
    border-bottom: 1px solid var(--hts-border);
    h1 {
        color: var(--hts-ink);
        font-size: 1.2rem;
        font-weight: 600;
    }
    p {
        color: var(--hts-ink-muted);
        font-size: 0.8rem;
        overflow-wrap: anywhere;
    }
`;
const GameMark = styled.div`
    display: grid;
    width: 2.7rem;
    height: 2.7rem;
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid #496184;
    border-radius: 50%;
    background: var(--hts-surface-soft);
    color: #b9d9ff;
    font-size: 1.25rem;
`;
const HeaderStatus = styled.div`
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-left: auto;
    border: 1px solid var(--hts-border);
    border-radius: 999px;
    padding: 0.42rem 0.7rem;
    color: var(--hts-ink-soft);
    font-size: 0.73rem;
    white-space: nowrap;
`;
const SidePanel = styled(Surface)`
    position: sticky;
    top: 1rem;
    @media (max-width: 1050px) {
        position: static;
    }
`;
const SideList = styled.div`
    display: grid;
    gap: 0.55rem;
    margin: 0.75rem 0;
`;
const SideItem = styled.div`
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.55rem;
    border: 1px solid var(--hts-border);
    border-radius: 0.45rem;
    background: var(--hts-surface-soft);
    padding: 0.4rem;
    img {
        width: 3.1rem;
        height: 3.1rem;
        flex: 0 0 auto;
        border-radius: 0.3rem;
        object-fit: cover;
    }
    div {
        min-width: 0;
        flex: 1;
    }
    strong,
    small {
        display: block;
        overflow: hidden;
        color: var(--hts-ink);
        font-size: 0.75rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    small {
        margin-top: 0.22rem;
        color: var(--hts-ink-muted);
        font-size: 0.65rem;
    }
    button {
        flex: 0 0 auto;
        color: #c5d5ef;
    }
`;
const StickyActions = styled.footer`
    position: fixed;
    z-index: 40;
    right: 0;
    bottom: 0;
    left: 15.75rem;
    display: flex;
    min-height: 4rem;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    border-top: 1px solid var(--hts-border);
    background: rgba(10, 17, 32, 0.97);
    padding: 0.55rem max(1rem, calc((100vw - 100rem) / 2));
    @media (max-width: 800px) {
        left: 0;
        flex-wrap: wrap;
    }
`;
const ActionGroup = styled.div`
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.45rem;
`;
const InlineChips = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: 0.65rem 0;
    span {
        border: 1px solid var(--hts-border);
        border-radius: 99px;
        padding: 0.2rem 0.5rem;
        color: var(--hts-ink-soft);
        font-size: 0.7rem;
    }
    button {
        margin-left: 0.3rem;
        color: #fca5a5;
    }
`;
const ErrorText = styled.p`
    margin: 0.65rem 0;
    color: #fca5a5;
    font-size: 0.82rem;
`;
const SubtleButton = styled.button`
    border: 1px solid var(--hts-border);
    border-radius: 0.4rem;
    background: transparent;
    padding: 0.45rem 0.6rem;
    color: var(--hts-ink-soft);
    font-size: 0.74rem;
    cursor: pointer;
`;
const AddedCount = styled.span`
    display: inline-grid;
    min-width: 1.2rem;
    height: 1.2rem;
    place-items: center;
    border-radius: 999px;
    background: var(--hts-border-blue);
    padding: 0 0.3rem;
    font-size: 0.66rem;
`;

const manualModIds = (value: string) =>
    uniqueWorkshopValues(value.split(/[;,]/)).filter((id) => /^[A-Za-z0-9_.-]{1,128}$/.test(id));

export default () => {
    const server = ServerContext.useStoreState((state) => state.server.data!);
    const [configuration, setConfiguration] = useState<WorkshopConfiguration>();
    const [workshopItems, setWorkshopItems] = useState<string[]>([]);
    const [mods, setMods] = useState<string[]>([]);
    const [results, setResults] = useState<WorkshopItem[]>([]);
    const catalogRequestId = useRef(0);
    const [catalogMode, setCatalogMode] = useState<WorkshopBrowseMode | 'installed'>('trending');
    const [searchVersion, setSearchVersion] = useState(0);
    const [page, setPage] = useState(1);
    const [hasNext, setHasNext] = useState(false);
    const [total, setTotal] = useState(0);
    const [query, setQuery] = useState('');
    const searchQuery = useRef('');
    const [buildTag, setBuildTag] = useState<string | null>(null);
    const [categoryTags, setCategoryTags] = useState<string[]>([]);
    const [selectedCandidates, setSelectedCandidates] = useState<Map<string, WorkshopItem>>(new Map());
    const [importedCollectionDetails, setImportedCollectionDetails] = useState<WorkshopItem[]>([]);
    const [manualIds, setManualIds] = useState<Record<string, string>>({});
    const [manualFallback, setManualFallback] = useState<Set<string>>(new Set());
    const [manualMod, setManualMod] = useState('');
    const [showManualEditor, setShowManualEditor] = useState(false);
    const [detailItem, setDetailItem] = useState<WorkshopItem | null>(null);
    const [loading, setLoading] = useState(true);
    const [searching, setSearching] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [resolving, setResolving] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const tags = useMemo(
        () => [...(buildTag ? [buildTag] : []), ...categoryTags].slice(0, 8),
        [buildTag, categoryTags]
    );
    const configured = useMemo(() => new Set(workshopItems), [workshopItems]);
    const details = useMemo(() => {
        const map = new Map<string, WorkshopItem>();
        [
            ...(configuration?.details || []),
            ...results,
            ...importedCollectionDetails,
            ...Array.from(selectedCandidates.values()),
        ].forEach((item) => map.set(item.workshopId, item));
        return map;
    }, [configuration?.details, results, importedCollectionDetails, selectedCandidates]);
    const changed = hasWorkshopChanges(configuration, workshopItems, mods);

    const loadCatalog = useCallback(
        async (mode: WorkshopBrowseMode, nextPage = 1, append = false, searchQuery = '') => {
            const requestId = ++catalogRequestId.current;
            if (!append) {
                setResults([]);
                setPage(1);
                setHasNext(false);
                setTotal(0);
            }
            append ? setLoadingMore(true) : setSearching(true);
            setError('');
            try {
                const result = await searchWorkshop(
                    server.uuid,
                    mode === 'search' ? searchQuery.trim() : '',
                    nextPage,
                    30,
                    mode,
                    tags
                );
                if (requestId !== catalogRequestId.current) return;
                setResults((current) => (append ? appendWorkshopResults(current, result.items) : result.items));
                setPage(result.pagination.page);
                setHasNext(result.pagination.hasNext);
                setTotal(result.pagination.total);
                setCatalogMode(mode);
            } catch (requestError) {
                if (requestId === catalogRequestId.current) setError(httpErrorToHuman(requestError));
            } finally {
                if (requestId === catalogRequestId.current) {
                    setSearching(false);
                    setLoadingMore(false);
                }
            }
        },
        [server.uuid, tags]
    );

    useEffect(() => {
        return () => {
            catalogRequestId.current += 1;
        };
    }, []);

    useEffect(() => {
        let active = true;
        const initialize = async () => {
            setLoading(true);
            try {
                const data = await getWorkshopConfiguration(server.uuid);
                if (!active) return;
                setConfiguration(data);
                setWorkshopItems(data.workshopItems);
                setMods(data.mods);
            } catch (requestError) {
                if (active) setError(httpErrorToHuman(requestError));
            } finally {
                if (active) setLoading(false);
            }
        };
        void initialize();
        return () => {
            active = false;
        };
    }, [server.uuid]);

    useEffect(() => {
        if (!loading && catalogMode !== 'installed') {
            void loadCatalog(catalogMode, 1, false, catalogMode === 'search' ? searchQuery.current : '');
        }
    }, [catalogMode, loading, loadCatalog, searchVersion]);

    const invalidateCatalog = () => {
        catalogRequestId.current += 1;
        setResults([]);
        setPage(1);
        setHasNext(false);
        setTotal(0);
        setSearching(false);
        setLoadingMore(false);
        setError('');
    };

    const runSearch = (event: FormEvent) => {
        event.preventDefault();
        if (query.trim().length >= 2) {
            invalidateCatalog();
            setCatalogMode('search');
            setSearchVersion((value) => value + 1);
        }
    };

    const chooseMode = (mode: WorkshopBrowseMode | 'installed') => {
        if (catalogMode === mode) return;
        invalidateCatalog();
        setCatalogMode(mode);
    };

    const toggleTag = (tag: string) => {
        invalidateCatalog();
        setCategoryTags((current) =>
            current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag].slice(0, 7)
        );
    };

    const selectCandidate = async (item: WorkshopItem) => {
        if (configured.has(item.workshopId) || resolving) return;
        if (selectedCandidates.has(item.workshopId)) {
            setSelectedCandidates((current) => {
                const next = new Map(current);
                next.delete(item.workshopId);
                return next;
            });
            return;
        }

        setResolving(item.workshopId);
        setError('');
        let resolved = item;
        if (!resolved.modIds.length) {
            try {
                resolved = await resolveWorkshopItem(server.uuid, item.workshopId);
                setResults((current) =>
                    current.map((entry) =>
                        entry.workshopId === resolved.workshopId ? { ...entry, ...resolved } : entry
                    )
                );
            } catch (requestError) {
                const fallbackIds = manualModIds(manualIds[item.workshopId] || '');
                if (!fallbackIds.length) {
                    setManualFallback((current) => new Set(current).add(item.workshopId));
                    setError(
                        translateUiText(
                            '{{name}}: não foi possível descobrir o Mod ID. Informe o valor exato de mod.info.',
                            { name: item.name }
                        )
                    );
                    setResolving(null);
                    return;
                }
                resolved = { ...item, modIds: fallbackIds, modIdSource: null };
                setError(
                    translateUiText(
                        'Usando os Mod IDs informados manualmente. Confira se estão corretos antes de salvar.'
                    )
                );
            }
        }

        const ids = resolved.modIds.length ? resolved.modIds : manualModIds(manualIds[item.workshopId] || '');
        if (!ids.length) {
            setManualFallback((current) => new Set(current).add(item.workshopId));
            setError(
                translateUiText('{{name}}: informe o Mod ID exato antes de adicionar ao servidor.', { name: item.name })
            );
            setResolving(null);
            return;
        }

        resolved = { ...resolved, modIds: ids };
        setSelectedCandidates((current) => new Map(current).set(resolved.workshopId, resolved));
        setManualFallback((current) => {
            const next = new Set(current);
            next.delete(item.workshopId);
            return next;
        });
        setResolving(null);
    };

    const addSelected = () => {
        let nextItems = workshopItems;
        let nextMods = mods;
        selectedCandidates.forEach((item) => {
            const selection = addWorkshopSelection(nextItems, nextMods, item);
            nextItems = selection.workshopItems;
            nextMods = selection.mods;
        });
        setWorkshopItems(nextItems);
        setMods(nextMods);
        setSelectedCandidates(new Map());
        setNotice(translateUiText('Seleção adicionada à configuração pendente. Salve para aplicar no servidor.'));
    };

    const remove = (workshopId: string) => {
        const selection = removeWorkshopSelection(workshopItems, mods, workshopId, details);
        setWorkshopItems(selection.workshopItems);
        setMods(selection.mods);
    };

    const addManualMod = () => {
        const values = manualModIds(manualMod);
        if (!values.length) return;
        setMods((current) => uniqueWorkshopValues([...current, ...values]));
        setManualMod('');
    };

    const save = async (restart: boolean) => {
        if (!configuration || !changed) return;
        setSaving(true);
        setError('');
        setNotice('');
        try {
            const result = await saveWorkshop(
                server.uuid,
                {
                    workshopItems,
                    mods,
                    revision: configuration.revision,
                    workshopMods: Object.fromEntries(workshopItems.map((id) => [id, details.get(id)?.modIds || []])),
                },
                restart
            );
            const nextConfiguration = {
                ...configuration,
                ...result,
                details: Array.from(details.values()),
                detailsError: null,
            };
            setConfiguration(nextConfiguration);
            setWorkshopItems(result.workshopItems);
            setMods(result.mods);
            setNotice(
                result.restartError ||
                    (result.restarted ? 'Configuração salva; reinício solicitado.' : 'Configuração salva no servidor.')
            );
        } catch (requestError) {
            setError(httpErrorToHuman(requestError));
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <Spinner size='large' centered />;

    const visibleItems =
        catalogMode === 'installed'
            ? (configuration?.workshopItems || []).map(
                  (id) =>
                      details.get(id) || {
                          workshopId: id,
                          name: `Workshop item ${id}`,
                          image: null,
                          description: '',
                          modIds: [],
                          modIdSource: null,
                          tags: [],
                          score: null,
                          votesUp: null,
                          votesDown: null,
                          subscriptions: null,
                          creatorId: null,
                          updatedAt: null,
                      }
              )
            : results;
    const status = changed ? 'Alterações pendentes' : 'Configuração sincronizada';

    return (
        <ServerContentBlock title={translateUiText('Workshop Mods')}>
            <PageGrid>
                <MainColumn>
                    <Cover>
                        <GameMark aria-hidden='true'>♟</GameMark>
                        <div style={{ minWidth: 0 }}>
                            <h1>{translateUiText('Project Zomboid Workshop Mods')}</h1>
                            <p>
                                {configuration?.path ||
                                    translateUiText('Descubra mods e sincronize Workshop IDs e Mod IDs do servidor.')}
                            </p>
                        </div>
                        <HeaderStatus>
                            <span style={{ color: changed ? '#fbbf24' : '#4ade80' }}>●</span>
                            {translateUiText(status)}
                        </HeaderStatus>
                    </Cover>
                    <Surface style={{ marginTop: '.8rem' }}>
                        <WorkshopFilters
                            mode={catalogMode}
                            onMode={chooseMode}
                            query={query}
                            onQuery={(value) => {
                                searchQuery.current = value;
                                setQuery(value);
                            }}
                            onSearch={runSearch}
                            searching={searching}
                            build={buildTag}
                            onBuild={(build) => {
                                invalidateCatalog();
                                setBuildTag(build);
                            }}
                            selectedTags={categoryTags}
                            onToggleTag={toggleTag}
                        />
                        <Can action='integration.workshop-update'>
                            <WorkshopCollectionImport
                                uuid={server.uuid}
                                configured={configured}
                                onImport={(items) => {
                                    let nextItems = workshopItems;
                                    let nextMods = mods;
                                    items.forEach((item) => {
                                        const selection = addWorkshopSelection(nextItems, nextMods, item);
                                        nextItems = selection.workshopItems;
                                        nextMods = selection.mods;
                                    });
                                    if (nextItems.length > 500 || nextMods.length > 500) return false;
                                    setWorkshopItems(nextItems);
                                    setMods(nextMods);
                                    setImportedCollectionDetails((current) => appendWorkshopResults(current, items));
                                    setNotice(
                                        translateUiText(
                                            'Coleção adicionada às alterações pendentes. Clique em Salvar para aplicar no servidor.'
                                        )
                                    );
                                    return true;
                                }}
                            />
                        </Can>
                        {configuration?.detailsError && (
                            <Muted style={{ marginTop: '.7rem' }}>
                                {configuration.detailsError}{' '}
                                {translateUiText('A lista configurada continua disponível abaixo.')}
                            </Muted>
                        )}
                        {notice && (
                            <Muted style={{ marginTop: '.65rem', color: '#86efac' }}>{translateUiText(notice)}</Muted>
                        )}
                        {error && <ErrorText role='alert'>{error}</ErrorText>}
                        <Heading style={{ marginTop: '1rem' }}>
                            <div>
                                <h2>
                                    {catalogMode === 'installed'
                                        ? translateUiText('Instalados na configuração')
                                        : catalogMode === 'search'
                                        ? translateUiText('Resultados da busca')
                                        : catalogMode === 'most_subscribed'
                                        ? translateUiText('Mais inscritos')
                                        : catalogMode === 'recent'
                                        ? translateUiText('Atualizados recentemente')
                                        : translateUiText('Mods em alta')}
                                </h2>
                                <p>
                                    {catalogMode === 'installed'
                                        ? translateUiText('Workshop IDs atualmente salvos no servidor')
                                        : translateUiText('{{count}} results from Steam Workshop for Project Zomboid', {
                                              count: total.toLocaleString(
                                                  getBrowserLocale() === 'pt' ? 'pt-BR' : 'en-US'
                                              ),
                                          })}
                                </p>
                            </div>
                            {catalogMode !== 'installed' && (
                                <a
                                    href='https://steamcommunity.com/app/108600/workshop/'
                                    target='_blank'
                                    rel='noreferrer'
                                >
                                    {translateUiText('Ver no Steam ↗')}
                                </a>
                            )}
                        </Heading>
                        {searching && !visibleItems.length ? (
                            <WorkshopSkeletonGrid />
                        ) : (
                            <WorkshopCards
                                items={visibleItems}
                                selected={new Set(selectedCandidates.keys())}
                                configured={configured}
                                manualIds={manualIds}
                                manualFallback={manualFallback}
                                onSelect={(item) => void selectCandidate(item)}
                                onOpen={setDetailItem}
                                onManualIdChange={(id, value) =>
                                    setManualIds((current) => ({ ...current, [id]: value }))
                                }
                                emptyMessage={
                                    catalogMode === 'installed'
                                        ? translateUiText('Ainda não há Workshop IDs salvos neste servidor.')
                                        : undefined
                                }
                            />
                        )}
                        {hasNext && catalogMode !== 'installed' && (
                            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
                                <Button
                                    type='button'
                                    isSecondary
                                    isLoading={loadingMore}
                                    disabled={searching || loadingMore}
                                    onClick={() =>
                                        void loadCatalog(
                                            catalogMode,
                                            page + 1,
                                            true,
                                            catalogMode === 'search' ? searchQuery.current : ''
                                        )
                                    }
                                >
                                    {translateUiText('Carregar mais')}
                                </Button>
                            </div>
                        )}
                    </Surface>
                </MainColumn>

                <SidePanel>
                    <Heading>
                        <div>
                            <h2>{translateUiText('Itens na configuração pendente')}</h2>
                            <p>{translateUiText('Alterações aplicadas ao salvar')}</p>
                        </div>
                        <AddedCount>{workshopItems.length}</AddedCount>
                    </Heading>
                    {!workshopItems.length ? (
                        <Muted style={{ marginTop: '.8rem' }}>
                            {translateUiText('Selecione mods do catálogo para preparar a configuração.')}
                        </Muted>
                    ) : (
                        <SideList>
                            {workshopItems.map((id) => {
                                const item = details.get(id);
                                return (
                                    <SideItem key={id}>
                                        {item?.image ? (
                                            <img src={item.image} alt='' loading='lazy' />
                                        ) : (
                                            <div
                                                aria-hidden='true'
                                                style={{
                                                    width: '3.1rem',
                                                    height: '3.1rem',
                                                    display: 'grid',
                                                    placeItems: 'center',
                                                    background: '#101a2c',
                                                }}
                                            >
                                                ♟
                                            </div>
                                        )}
                                        <div>
                                            <strong>{item?.name || `Workshop item ${id}`}</strong>
                                            <small>
                                                {translateUiText('Workshop ID:')} {id}
                                            </small>
                                        </div>
                                        <Can action='integration.workshop-update'>
                                            <button
                                                type='button'
                                                aria-label={translateUiText('Remover {{id}}', { id })}
                                                disabled={saving}
                                                onClick={() => remove(id)}
                                            >
                                                ×
                                            </button>
                                        </Can>
                                    </SideItem>
                                );
                            })}
                        </SideList>
                    )}
                    <div style={{ borderTop: '1px solid var(--hts-border)', paddingTop: '.7rem' }}>
                        <Heading>
                            <h2>{translateUiText('Mod IDs do servidor')}</h2>
                            <AddedCount>{mods.length}</AddedCount>
                        </Heading>
                        <InlineChips>
                            {mods.map((id) => (
                                <span key={id}>
                                    {id}
                                    <Can action='integration.workshop-update'>
                                        <button
                                            type='button'
                                            aria-label={translateUiText('Remover Mod ID {{id}}', { id })}
                                            onClick={() =>
                                                setMods((current) => current.filter((value) => value !== id))
                                            }
                                        >
                                            ×
                                        </button>
                                    </Can>
                                </span>
                            ))}
                        </InlineChips>
                        <Can action='integration.workshop-update'>
                            <SubtleButton type='button' onClick={() => setShowManualEditor((value) => !value)}>
                                {translateUiText('⚙ Gerenciar IDs manualmente')}
                            </SubtleButton>
                            {showManualEditor && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', marginTop: '.5rem' }}>
                                    <Input
                                        value={manualMod}
                                        onChange={(event) => setManualMod(event.currentTarget.value)}
                                        placeholder={translateUiText('Mod ID(s), separados por ;')}
                                    />
                                    <Button type='button' size='xsmall' isSecondary onClick={addManualMod}>
                                        {translateUiText('Adicionar')}
                                    </Button>
                                </div>
                            )}
                        </Can>
                    </div>
                </SidePanel>
            </PageGrid>

            <Can action='integration.workshop-update'>
                <StickyActions>
                    <div>
                        <strong style={{ color: 'var(--hts-ink)', fontSize: '.85rem' }}>
                            {selectedCandidates.size} {translateUiText('mods selecionados')}
                        </strong>
                        <p style={{ color: 'var(--hts-ink-muted)', fontSize: '.7rem' }}>
                            {translateUiText('Selecione no catálogo antes de adicionar à configuração')}
                        </p>
                    </div>
                    <ActionGroup>
                        <Button
                            type='button'
                            color='primary'
                            disabled={!selectedCandidates.size || saving}
                            onClick={addSelected}
                        >
                            {translateUiText('⊕ Adicionar selecionados')}
                        </Button>
                        <Button
                            type='button'
                            isSecondary
                            disabled={!changed || saving}
                            isLoading={saving}
                            onClick={() => void save(false)}
                        >
                            {translateUiText('▣ Salvar')}
                        </Button>
                        <Can action='control.restart'>
                            <Button
                                type='button'
                                disabled={!changed || saving}
                                isLoading={saving}
                                onClick={() => void save(true)}
                            >
                                {translateUiText('▶ Salvar e Reiniciar')}
                            </Button>
                        </Can>
                    </ActionGroup>
                </StickyActions>
            </Can>

            <WorkshopDetails
                item={detailItem}
                onClose={() => setDetailItem(null)}
                onSelect={(item) => {
                    setDetailItem(null);
                    void selectCandidate(item);
                }}
                configured={!!detailItem && configured.has(detailItem.workshopId)}
            />
        </ServerContentBlock>
    );
};
