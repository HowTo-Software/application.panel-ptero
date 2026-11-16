import { translateUiText } from '@/i18n/uiTranslations';
import React, { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components/macro';
import Button from '@/components/elements/Button';
import { ServerContext } from '@/state/server';
import { WorkshopBrowseMode, WorkshopItem } from '@/api/server/howtoo';
import { Heading, PageGrid, Surface, WorkshopCards, WorkshopDetails, WorkshopFilters } from './WorkshopCatalog';

const PreviewShell = styled.div`
    min-height: 100vh;
    background: #080b17;
    color: var(--hts-ink);
`;

const Topbar = styled.header`
    position: sticky;
    z-index: 20;
    top: 0;
    display: flex;
    height: 3.5rem;
    align-items: center;
    gap: 0.8rem;
    border-bottom: 1px solid var(--hts-border);
    background: #080b17;
    padding: 0 1.2rem;
    strong {
        font-size: 1.05rem;
    }
    span {
        margin-left: auto;
        color: var(--hts-ink-muted);
        font-size: 0.75rem;
    }
`;

const ShellBody = styled.div`
    display: grid;
    grid-template-columns: 15.5rem minmax(0, 1fr);
    min-height: calc(100vh - 3.5rem);
    @media (max-width: 760px) {
        grid-template-columns: minmax(0, 1fr);
    }
`;

const PreviewNav = styled.aside`
    border-right: 1px solid var(--hts-border);
    background: #080b17;
    padding: 1rem 0.75rem;
    color: var(--hts-ink-muted);
    @media (max-width: 760px) {
        display: none;
    }
    div {
        margin: 0.3rem 0;
        border-radius: 0.35rem;
        padding: 0.6rem;
        font-size: 0.82rem;
    }
    .active {
        border-left: 2px solid #853bea;
        background: rgba(124, 58, 237, 0.18);
        color: white;
    }
`;

const Main = styled.main`
    min-width: 0;
    padding: 1.2rem 1.4rem 6rem;
`;

const ServerHeading = styled.div`
    display: flex;
    align-items: center;
    gap: 0.8rem;
    border-bottom: 1px solid var(--hts-border);
    padding: 0.2rem 0 1rem;
    h1 {
        font-size: 1.2rem;
        font-weight: 600;
    }
    p {
        margin-top: 0.2rem;
        color: var(--hts-ink-muted);
        font-size: 0.8rem;
    }
    b {
        margin-left: auto;
        border: 1px solid var(--hts-border);
        border-radius: 99px;
        padding: 0.45rem 0.75rem;
        color: #93c5fd;
        font-size: 0.73rem;
        font-weight: 400;
    }
`;

const PendingList = styled.div`
    display: grid;
    gap: 0.55rem;
    margin-top: 0.8rem;
`;

const PendingItem = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    border: 1px solid var(--hts-border);
    border-radius: 0.4rem;
    background: var(--hts-surface-soft);
    padding: 0.6rem;
    font-size: 0.75rem;
    button {
        border: 0;
        background: transparent;
        color: #fca5a5;
        cursor: pointer;
    }
`;

const ActionBar = styled.footer`
    position: fixed;
    z-index: 10;
    right: 0;
    bottom: 0;
    left: 15.5rem;
    display: flex;
    min-height: 4rem;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    border-top: 1px solid var(--hts-border);
    background: rgba(10, 17, 32, 0.97);
    padding: 0.6rem 1.2rem;
    @media (max-width: 760px) {
        left: 0;
    }
`;

const fixtureItems: WorkshopItem[] = [
    {
        workshopId: '2982254489',
        name: 'Animal Care Fixes',
        image: null,
        description: translateUiText('Ajustes e melhorias para o cuidado dos animais no Project Zomboid.'),
        modIds: ['AnimalCareFixes'],
        modIdSource: 'steam_metadata',
        tags: ['Build 42', 'Animals'],
        score: 0.93,
        votesUp: 729,
        votesDown: 44,
        subscriptions: 18300,
        creatorId: null,
        updatedAt: 1758000000,
    },
    {
        workshopId: '2873490067',
        name: 'Exercises',
        image: null,
        description: translateUiText('Rotinas de exercício para os sobreviventes.'),
        modIds: ['Exercises'],
        modIdSource: 'steam_metadata',
        tags: ['Build 42', 'Balance'],
        score: 0.91,
        votesUp: 1100,
        votesDown: 86,
        subscriptions: 24100,
        creatorId: null,
        updatedAt: 1757000000,
    },
    {
        workshopId: '2911049324',
        name: 'RP Voice',
        image: null,
        description: translateUiText('Mais opções de voz e comunicação para o modo roleplay.'),
        modIds: ['RPVoice'],
        modIdSource: null,
        tags: ['Build 42', 'Interface'],
        score: 0.89,
        votesUp: 842,
        votesDown: 72,
        subscriptions: 12600,
        creatorId: null,
        updatedAt: 1756000000,
    },
    {
        workshopId: '3004179531',
        name: 'Gas Pump Indicator',
        image: null,
        description: translateUiText('Indica visualmente o combustível restante nas bombas.'),
        modIds: ['GasPumpIndicator'],
        modIdSource: 'steam_metadata',
        tags: ['Build 42', 'Interface'],
        score: 0.88,
        votesUp: 1000,
        votesDown: 114,
        subscriptions: 19800,
        creatorId: null,
        updatedAt: 1755000000,
    },
    {
        workshopId: '2785805307',
        name: 'The Mutants',
        image: null,
        description: translateUiText('Novas criaturas e desafios para o mundo.'),
        modIds: ['TheMutants'],
        modIdSource: 'steam_metadata',
        tags: ['Build 41', 'Hardmode'],
        score: 0.9,
        votesUp: 680,
        votesDown: 59,
        subscriptions: 15300,
        creatorId: null,
        updatedAt: 1754000000,
    },
    {
        workshopId: '2863127292',
        name: 'Fence Sheets',
        image: null,
        description: translateUiText('Novas opções de construção e cercas.'),
        modIds: ['FenceSheets'],
        modIdSource: 'steam_metadata',
        tags: ['Build 42', 'Building'],
        score: 0.87,
        votesUp: 512,
        votesDown: 77,
        subscriptions: 9200,
        creatorId: null,
        updatedAt: 1753000000,
    },
    {
        workshopId: '2769239843',
        name: 'Dynamic Tarps Covers',
        image: null,
        description: translateUiText('Coberturas dinâmicas para veículos e objetos.'),
        modIds: ['DynamicTarps'],
        modIdSource: null,
        tags: ['Build 42', 'Items'],
        score: 0.9,
        votesUp: 512,
        votesDown: 45,
        subscriptions: 17100,
        creatorId: null,
        updatedAt: 1752000000,
    },
    {
        workshopId: '2832136889',
        name: 'More Furniture',
        image: null,
        description: translateUiText('Uma coleção de móveis para personalizar as construções.'),
        modIds: ['MoreFurniture'],
        modIdSource: 'steam_metadata',
        tags: ['Build 42', 'Building'],
        score: 0.92,
        votesUp: 918,
        votesDown: 61,
        subscriptions: 20500,
        creatorId: null,
        updatedAt: 1751000000,
    },
];

function PreviewContent() {
    const [permissionsReady, setPermissionsReady] = useState(false);
    const setPermissions = ServerContext.useStoreActions((actions) => actions.server.setPermissions);
    const [mode, setMode] = useState<WorkshopBrowseMode | 'installed'>('trending');
    const [query, setQuery] = useState('');
    const [build, setBuild] = useState<string | null>(null);
    const [tags, setTags] = useState<string[]>([]);
    const [selected, setSelected] = useState<WorkshopItem[]>([]);
    const [configured, setConfigured] = useState<WorkshopItem[]>([fixtureItems[3]]);
    const [detail, setDetail] = useState<WorkshopItem | null>(null);
    const [notice, setNotice] = useState('');

    useEffect(() => {
        setPermissions(['integration.workshop-update']);
        setPermissionsReady(true);
    }, [setPermissions]);

    const visibleItems = useMemo(() => {
        let items = mode === 'installed' ? configured : fixtureItems;
        if (query.trim()) {
            const normalized = query.trim().toLowerCase();
            items = items.filter((item) =>
                `${item.name} ${item.workshopId} ${item.description}`.toLowerCase().includes(normalized)
            );
        }
        if (build) items = items.filter((item) => item.tags.includes(build));
        if (tags.length) items = items.filter((item) => tags.every((tag) => item.tags.includes(tag)));
        if (mode === 'most_subscribed')
            items = [...items].sort((a, b) => (b.subscriptions || 0) - (a.subscriptions || 0));
        if (mode === 'recent') items = [...items].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return items;
    }, [build, configured, mode, query, tags]);

    const toggleTag = (tag: string) =>
        setTags((current) => (current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag]));
    const selectItem = (item: WorkshopItem) => {
        if (configured.some((value) => value.workshopId === item.workshopId)) return;
        setSelected((current) =>
            current.some((value) => value.workshopId === item.workshopId)
                ? current.filter((value) => value.workshopId !== item.workshopId)
                : [...current, item]
        );
    };
    const save = (restart: boolean) => {
        setConfigured((current) => [
            ...current,
            ...selected.filter((item) => !current.some((saved) => saved.workshopId === item.workshopId)),
        ]);
        setSelected([]);
        setNotice(restart ? 'Prévia: configuração salva e servidor reiniciado.' : 'Prévia: configuração salva.');
    };

    if (!permissionsReady) return null;

    return (
        <PreviewShell>
            <Topbar>
                <strong>{translateUiText('HowTo.Software')}</strong>
                <span>{translateUiText('PRÉVIA LOCAL · dados de demonstração')}</span>
            </Topbar>
            <ShellBody>
                <PreviewNav>
                    <div>{translateUiText('Console')}</div>
                    <div>{translateUiText('Files')}</div>
                    <div>{translateUiText('Databases')}</div>
                    <div>{translateUiText('Schedules')}</div>
                    <div>{translateUiText('Settings')}</div>
                    <div className='active'>{translateUiText('Workshop Mods')}</div>
                </PreviewNav>
                <Main>
                    <ServerHeading>
                        <span aria-hidden='true' style={{ fontSize: '1.8rem' }}>
                            ◉
                        </span>
                        <div>
                            <h1>{translateUiText('Project Zomboid Workshop Mods')}</h1>
                            <p>{translateUiText('/cache/Server/Pterodactyl.ini · Malaio Code')}</p>
                        </div>
                        <b>{translateUiText('● Configuration synced')}</b>
                    </ServerHeading>
                    <PageGrid style={{ marginTop: '1rem' }}>
                        <Surface>
                            <WorkshopFilters
                                mode={mode}
                                onMode={setMode}
                                query={query}
                                onQuery={setQuery}
                                onSearch={(event) => {
                                    event.preventDefault();
                                    setMode('search');
                                }}
                                searching={false}
                                build={build}
                                onBuild={setBuild}
                                selectedTags={tags}
                                onToggleTag={toggleTag}
                            />
                            <Heading style={{ marginTop: '1rem' }}>
                                <div>
                                    <h2>
                                        {mode === 'installed'
                                            ? translateUiText('Instalados')
                                            : mode === 'most_subscribed'
                                            ? translateUiText('Mais inscritos')
                                            : mode === 'recent'
                                            ? translateUiText('Atualizados recentemente')
                                            : translateUiText('Mods em alta')}
                                    </h2>
                                    <p>{translateUiText('Mods populares na comunidade Steam para Project Zomboid')}</p>
                                </div>
                                {notice && (
                                    <span style={{ color: '#86efac', fontSize: '.75rem' }}>
                                        {translateUiText(notice)}
                                    </span>
                                )}
                            </Heading>
                            <WorkshopCards
                                items={visibleItems}
                                selected={new Set(selected.map((item) => item.workshopId))}
                                configured={new Set(configured.map((item) => item.workshopId))}
                                onSelect={selectItem}
                                onOpen={setDetail}
                            />
                        </Surface>
                        <Surface>
                            <Heading>
                                <div>
                                    <h2>{translateUiText('Itens configurados no servidor')}</h2>
                                    <p>{translateUiText('Mods do Workshop instalados neste servidor')}</p>
                                </div>
                                <span>{configured.length}</span>
                            </Heading>
                            <PendingList>
                                {configured.map((item) => (
                                    <PendingItem key={item.workshopId}>
                                        <span>
                                            {item.name}
                                            <br />
                                            <small>
                                                {translateUiText('Workshop ID:')} {item.workshopId}
                                            </small>
                                        </span>
                                        <button
                                            type='button'
                                            aria-label={translateUiText('Remover {{name}}', { name: item.name })}
                                            onClick={() =>
                                                setConfigured((current) =>
                                                    current.filter((entry) => entry.workshopId !== item.workshopId)
                                                )
                                            }
                                        >
                                            ×
                                        </button>
                                    </PendingItem>
                                ))}
                                {selected.map((item) => (
                                    <PendingItem key={item.workshopId}>
                                        <span>
                                            + {item.name}
                                            <br />
                                            <small>{translateUiText('Será adicionado ao salvar')}</small>
                                        </span>
                                        <button
                                            type='button'
                                            aria-label={translateUiText('Desfazer {{name}}', { name: item.name })}
                                            onClick={() =>
                                                setSelected((current) =>
                                                    current.filter((entry) => entry.workshopId !== item.workshopId)
                                                )
                                            }
                                        >
                                            ×
                                        </button>
                                    </PendingItem>
                                ))}
                            </PendingList>
                        </Surface>
                    </PageGrid>
                </Main>
            </ShellBody>
            <ActionBar>
                <div>
                    {selected.length} {translateUiText('mods selecionados')}
                </div>
                <div style={{ display: 'flex', gap: '.5rem' }}>
                    <Button type='button' isSecondary disabled={!selected.length} onClick={() => save(false)}>
                        {translateUiText('Salvar')}
                    </Button>
                    <Button type='button' disabled={!selected.length} onClick={() => save(true)}>
                        {translateUiText('Salvar e Reiniciar')}
                    </Button>
                </div>
            </ActionBar>
            <WorkshopDetails
                item={detail}
                onClose={() => setDetail(null)}
                onSelect={selectItem}
                configured={configured.some((item) => item.workshopId === detail?.workshopId)}
            />
        </PreviewShell>
    );
}

export default function WorkshopPreview() {
    return (
        <ServerContext.Provider>
            <PreviewContent />
        </ServerContext.Provider>
    );
}
