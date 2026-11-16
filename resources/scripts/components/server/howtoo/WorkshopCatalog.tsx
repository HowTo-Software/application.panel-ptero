import { translateUiText } from '@/i18n/uiTranslations';
import { getBrowserLocale } from '@/i18n/locale';
import React, { useEffect, useState } from 'react';
import styled from 'styled-components/macro';
import Button from '@/components/elements/Button';
import Input from '@/components/elements/Input';
import Can from '@/components/elements/Can';
import { WorkshopBrowseMode, WorkshopItem } from '@/api/server/howtoo';

const categories = [
    'Animals',
    'Audio',
    'Balance',
    'Building',
    'Clothing/Armor',
    'Farming',
    'Food',
    'Framework',
    'Hardmode',
    'Interface',
    'Items',
    'Language/Translation',
    'Literature',
    'Map',
];

export const PageGrid = styled.div`
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr) minmax(17rem, 20rem);
    gap: 1rem;
    align-items: start;

    @media (max-width: 1050px) {
        grid-template-columns: minmax(0, 1fr);
    }
`;

export const Surface = styled.section`
    min-width: 0;
    border: 1px solid var(--hts-border);
    border-radius: 0.625rem;
    background: var(--hts-surface);
    padding: 0.875rem;
`;

export const Heading = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    h2 {
        color: var(--hts-ink);
        font-size: 1rem;
        font-weight: 600;
    }
    p {
        color: var(--hts-ink-muted);
        font-size: 0.8rem;
    }
`;

const Tabs = styled.div`
    display: flex;
    gap: 0.35rem;
    overflow-x: auto;
    border-bottom: 1px solid var(--hts-border);
    margin: 0.9rem 0 0;
`;

const Tab = styled.button<{ $active: boolean }>`
    flex: 0 0 auto;
    border: 0;
    border-bottom: 3px solid ${(props) => (props.$active ? '#853bea' : 'transparent')};
    background: transparent;
    padding: 0.6rem 0.75rem;
    color: ${(props) => (props.$active ? 'var(--hts-ink)' : 'var(--hts-ink-muted)')};
    cursor: pointer;
    &:hover {
        color: var(--hts-ink);
    }
`;

const FilterRow = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.8rem 0;
`;
const MoreFilters = styled.div`
    position: relative;
    & > div {
        position: absolute;
        z-index: 5;
        top: calc(100% + 0.35rem);
        right: 0;
        display: flex;
        width: min(24rem, calc(100vw - 2rem));
        flex-wrap: wrap;
        gap: 0.35rem;
        border: 1px solid var(--hts-border);
        border-radius: 0.5rem;
        background: var(--hts-surface);
        padding: 0.6rem;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    }
`;

const Filter = styled.button<{ $active: boolean }>`
    border: 1px solid ${(props) => (props.$active ? '#853bea' : 'var(--hts-border)')};
    border-radius: 0.45rem;
    background: ${(props) => (props.$active ? 'rgba(124, 58, 237, .16)' : 'var(--hts-surface-soft)')};
    padding: 0.4rem 0.65rem;
    color: var(--hts-ink-soft);
    font-size: 0.76rem;
    cursor: pointer;
`;

const SearchRow = styled.form`
    display: flex;
    min-width: 0;
    gap: 0.5rem;
    & > div {
        min-width: 0;
        flex: 1;
    }
    button {
        flex: 0 0 auto;
    }
`;

const SearchInput = styled(Input)`
    background-color: #111a34 !important;
    border-color: #344a7a !important;
    color: #e5edff !important;

    &::placeholder {
        color: #8e9bbb !important;
        opacity: 1;
    }

    &:focus {
        border-color: #8875ff !important;
        box-shadow: 0 0 0 2px rgb(136 117 255 / 16%) !important;
    }
`;

export function WorkshopFilters({
    mode,
    onMode,
    query,
    onQuery,
    onSearch,
    searching,
    build,
    onBuild,
    selectedTags,
    onToggleTag,
}: {
    mode: WorkshopBrowseMode | 'installed';
    onMode: (mode: WorkshopBrowseMode | 'installed') => void;
    query: string;
    onQuery: (value: string) => void;
    onSearch: (event: React.FormEvent) => void;
    searching: boolean;
    build: string | null;
    onBuild: (build: string | null) => void;
    selectedTags: string[];
    onToggleTag: (tag: string) => void;
}) {
    const [showMore, setShowMore] = useState(false);
    return (
        <>
            <Tabs aria-label={translateUiText('Workshop catalog')}>
                {(
                    [
                        ['trending', 'Mods em alta'],
                        ['most_subscribed', 'Mais inscritos'],
                        ['recent', 'Atualizados recentemente'],
                    ] as [WorkshopBrowseMode, string][]
                ).map(([value, label]) => (
                    <Tab key={value} type='button' $active={mode === value} onClick={() => onMode(value)}>
                        {translateUiText(label)}
                    </Tab>
                ))}
                <Tab type='button' $active={mode === 'installed'} onClick={() => onMode('installed')}>
                    {translateUiText('▣ Instalados')}
                </Tab>
            </Tabs>
            <FilterRow aria-label={translateUiText('Workshop tags')}>
                <Filter
                    type='button'
                    $active={!build && selectedTags.length === 0}
                    onClick={() => {
                        onBuild(null);
                        selectedTags.forEach(onToggleTag);
                    }}
                >
                    {translateUiText('Todos')}
                </Filter>
                {['Build 42', 'Build 41'].map((value) => (
                    <Filter
                        type='button'
                        key={value}
                        $active={build === value}
                        onClick={() => onBuild(build === value ? null : value)}
                    >
                        {translateUiText(value)}
                    </Filter>
                ))}
                {categories.slice(0, 7).map((tag) => (
                    <Filter
                        type='button'
                        key={tag}
                        $active={selectedTags.includes(tag)}
                        onClick={() => onToggleTag(tag)}
                    >
                        {translateUiText(tag)}
                    </Filter>
                ))}
                <MoreFilters>
                    <Filter type='button' $active={showMore} onClick={() => setShowMore((value) => !value)}>
                        {translateUiText('Mais⌄')}
                    </Filter>
                    {showMore && (
                        <div>
                            {categories.slice(7).map((tag) => (
                                <Filter
                                    type='button'
                                    key={tag}
                                    $active={selectedTags.includes(tag)}
                                    onClick={() => onToggleTag(tag)}
                                >
                                    {translateUiText(tag)}
                                </Filter>
                            ))}
                        </div>
                    )}
                </MoreFilters>
            </FilterRow>
            <SearchRow onSubmit={onSearch}>
                <SearchInput
                    value={query}
                    onChange={(event) => onQuery(event.currentTarget.value)}
                    placeholder={translateUiText('Buscar mods por nome, Workshop ID ou URL do Steam Workshop...')}
                />
                <Button type='submit' isLoading={searching} disabled={searching || query.trim().length < 2}>
                    {translateUiText('Buscar')}
                </Button>
            </SearchRow>
        </>
    );
}

const ModGrid = styled.div`
    display: grid;
    min-width: 0;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.7rem;
    margin-top: 0.85rem;
    @media (max-width: 1450px) {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    @media (max-width: 1050px) {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    @media (max-width: 760px) {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    @media (max-width: 480px) {
        grid-template-columns: minmax(0, 1fr);
    }
`;

const ModCard = styled.article<{ $selected: boolean }>`
    display: flex;
    min-width: 0;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid ${(props) => (props.$selected ? '#853bea' : 'var(--hts-border)')};
    border-radius: 0.5rem;
    background: var(--hts-surface-soft);
    transition: transform 140ms ease, border-color 140ms ease;
    &:hover {
        transform: translateY(-2px);
        border-color: #7655a8;
    }
`;

const Preview = styled.button`
    display: grid;
    width: 100%;
    height: 7.5rem;
    place-items: center;
    overflow: hidden;
    border: 0;
    background: #101a2c;
    color: #94a3b8;
    cursor: pointer;
    img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
`;

const CardBody = styled.div`
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.6rem;
    h3 {
        overflow: hidden;
        color: var(--hts-ink);
        font-size: 0.85rem;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    p {
        overflow: hidden;
        color: var(--hts-ink-muted);
        font-size: 0.73rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    p:nth-of-type(2) {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        white-space: normal;
    }
`;

const Tags = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    span {
        border-radius: 0.25rem;
        background: rgba(66, 89, 130, 0.42);
        padding: 0.15rem 0.35rem;
        color: #d4dfef;
        font-size: 0.65rem;
    }
`;

const CardFooter = styled.div`
    display: flex;
    min-height: 2.25rem;
    align-items: center;
    justify-content: space-between;
    gap: 0.3rem;
    margin-top: auto;
    color: #8bbffc;
    font-size: 0.7rem;
    button {
        flex: 0 0 auto;
        border: 0;
        border-radius: 999px;
        background: #7237c8;
        width: 1.8rem;
        height: 1.8rem;
        color: white;
        font-size: 1rem;
        cursor: pointer;
    }
    button:disabled {
        opacity: 0.45;
        cursor: default;
    }
`;

export function WorkshopCards({
    items,
    selected,
    configured,
    resolving,
    onSelect,
    onOpen,
    emptyMessage,
}: {
    items: WorkshopItem[];
    selected: Set<string>;
    configured: Set<string>;
    resolving?: string | null;
    onSelect: (item: WorkshopItem) => void;
    onOpen: (item: WorkshopItem) => void;
    emptyMessage?: string;
}) {
    if (!items.length)
        return (
            <p style={{ marginTop: '1rem', color: 'var(--hts-ink-muted)', fontSize: '.85rem' }}>
                {emptyMessage || translateUiText('Nenhum mod encontrado com estes filtros.')}
            </p>
        );
    return (
        <ModGrid>
            {items.map((item) => {
                const isConfigured = configured.has(item.workshopId);
                const rating = item.score === null ? null : `${(item.score * 5).toFixed(1)} / 5`;
                return (
                    <ModCard key={item.workshopId} $selected={selected.has(item.workshopId)}>
                        <Preview
                            type='button'
                            onClick={() => onOpen(item)}
                            aria-label={translateUiText('Detalhes de {{name}}', { name: item.name })}
                        >
                            {item.image ? (
                                <img src={item.image} alt='' loading='lazy' />
                            ) : (
                                <span>{translateUiText('PROJECT ZOMBOID')}</span>
                            )}
                        </Preview>
                        <CardBody>
                            <button
                                type='button'
                                onClick={() => onOpen(item)}
                                style={{ border: 0, padding: 0, textAlign: 'left', background: 'transparent' }}
                            >
                                <h3>{item.name}</h3>
                            </button>
                            <p>
                                {translateUiText('Workshop ID:')} {item.workshopId}
                            </p>
                            <p>{item.description || translateUiText('Sem descrição disponível.')}</p>
                            <Tags>
                                {item.tags.slice(0, 3).map((tag) => (
                                    <span key={tag}>{tag}</span>
                                ))}
                            </Tags>
                            <CardFooter>
                                <span>
                                    {rating ? `★ ${rating} · ` : ''}
                                    {item.subscriptions === null
                                        ? translateUiText('Steam Workshop')
                                        : `${item.subscriptions.toLocaleString(
                                              getBrowserLocale() === 'pt' ? 'pt-BR' : 'en-US'
                                          )} ${translateUiText('subscribers')}`}
                                </span>
                                <Can action='integration.workshop-update'>
                                    <button
                                        type='button'
                                        onClick={() => onSelect(item)}
                                        disabled={isConfigured || !!resolving}
                                        aria-label={
                                            isConfigured
                                                ? translateUiText('Já configurado')
                                                : translateUiText('Selecionar mod')
                                        }
                                        title={
                                            isConfigured
                                                ? translateUiText('Já está configurado')
                                                : translateUiText('Selecionar mod')
                                        }
                                    >
                                        {resolving === item.workshopId
                                            ? translateUiText('Detectando Mod IDs')
                                            : isConfigured
                                            ? '✓'
                                            : selected.has(item.workshopId)
                                            ? '✓'
                                            : '+'}
                                    </button>
                                </Can>
                            </CardFooter>
                        </CardBody>
                    </ModCard>
                );
            })}
        </ModGrid>
    );
}

export function WorkshopSkeletonGrid() {
    return (
        <ModGrid aria-label={translateUiText('Carregando mods')}>
            {Array.from({ length: 8 }, (_, index) => (
                <div
                    key={index}
                    style={{
                        height: '17rem',
                        borderRadius: '.5rem',
                        background: 'var(--hts-surface-soft)',
                        border: '1px solid var(--hts-border)',
                        animation: 'pulse 1.5s ease-in-out infinite',
                    }}
                />
            ))}
        </ModGrid>
    );
}

const DialogShade = styled.div`
    position: fixed;
    z-index: 80;
    inset: 0;
    display: grid;
    place-items: center;
    overflow-y: auto;
    background: rgba(4, 8, 18, 0.82);
    padding: 1rem;
`;

const Dialog = styled.section`
    position: relative;
    width: min(44rem, 100%);
    max-height: 90vh;
    overflow-y: auto;
    border: 1px solid var(--hts-border);
    border-radius: 0.75rem;
    background: var(--hts-surface);
    padding: 1rem;
    h2 {
        margin: 0.7rem 0;
        color: var(--hts-ink);
        font-size: 1.2rem;
    }
    p {
        color: var(--hts-ink-muted);
        font-size: 0.85rem;
        white-space: pre-wrap;
    }
    img {
        width: 100%;
        max-height: 19rem;
        border-radius: 0.45rem;
        object-fit: cover;
    }
`;

export function WorkshopDetails({
    item,
    onClose,
    onSelect,
    configured,
}: {
    item: WorkshopItem | null;
    onClose: () => void;
    onSelect: (item: WorkshopItem) => void;
    configured: boolean;
}) {
    useEffect(() => {
        if (!item) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [item, onClose]);
    if (!item) return null;
    return (
        <DialogShade
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <Dialog role='dialog' aria-modal='true' aria-labelledby='workshop-modal-title'>
                <Button type='button' isSecondary onClick={onClose}>
                    {translateUiText('Fechar')}
                </Button>
                {item.image && <img src={item.image} alt='' />}
                <h2 id='workshop-modal-title'>{item.name}</h2>
                <p>
                    {translateUiText('Workshop ID:')} {item.workshopId}
                </p>
                <Tags>
                    {item.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                    ))}
                </Tags>
                <p>{item.description || translateUiText('Sem descrição disponível.')}</p>
                <p>
                    {translateUiText('Mod IDs:')}{' '}
                    {item.modIds.length ? item.modIds.join('; ') : translateUiText('Será verificado ao selecionar.')}
                </p>
                <p>
                    {translateUiText('Atualizado em:')}{' '}
                    {item.updatedAt
                        ? new Date(item.updatedAt * 1000).toLocaleDateString(
                              getBrowserLocale() === 'pt' ? 'pt-BR' : 'en-US'
                          )
                        : translateUiText('Não informado')}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', marginTop: '1rem' }}>
                    <a
                        href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(
                            item.workshopId
                        )}`}
                        target='_blank'
                        rel='noreferrer'
                    >
                        {translateUiText('Abrir no Steam ↗')}
                    </a>
                    <Can action='integration.workshop-update'>
                        <Button type='button' disabled={configured} onClick={() => onSelect(item)}>
                            {configured
                                ? translateUiText('Já configurado')
                                : translateUiText('Selecionar para o servidor')}
                        </Button>
                    </Can>
                </div>
            </Dialog>
        </DialogShade>
    );
}

export { categories as WORKSHOP_CATEGORIES };
