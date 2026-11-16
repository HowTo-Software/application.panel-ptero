import { WorkshopConfiguration, WorkshopItem, WorkshopModIdReason } from '@/api/server/howtoo';

export const uniqueWorkshopValues = (values: string[]): string[] =>
    Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

/** Mod IDs typed by the user: ";" separated, B42 "\Id" prefixes removed, same limits as the server. */
export const parseManualModIds = (value: string): string[] =>
    uniqueWorkshopValues(value.split(';').map((id) => id.trim().replace(/^\\+/, ''))).filter(
        // eslint-disable-next-line no-control-regex
        (id) => id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(id)
    );

export const toggleWorkshopModId = (mods: string[], modId: string): string[] =>
    mods.includes(modId) ? mods.filter((id) => id !== modId) : [...mods, modId];

export const placeholderWorkshopItem = (workshopId: string): WorkshopItem => ({
    workshopId,
    name: `Workshop item ${workshopId}`,
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
});

/** Adds Mod IDs the user typed for an item the panel could not resolve. */
export const withManualModIds = (item: WorkshopItem, manual: string[] | undefined): WorkshopItem =>
    manual?.length ? { ...item, modIds: uniqueWorkshopValues([...item.modIds, ...manual]) } : item;

/** Portuguese source text (translated by translateUiText) explaining a missing Mod ID. */
export const workshopModIdReasonText = (reason: WorkshopModIdReason | null | undefined): string => {
    switch (reason) {
        case 'downloader_unavailable':
            return 'o leitor de arquivos do Workshop não está instalado neste painel';
        case 'inspection_failed':
            return 'a leitura dos arquivos do Workshop falhou';
        case 'queue_stalled':
            return 'a fila "workshop" não está sendo processada';
        case 'no_published_files':
            return 'o item não publica arquivos no Workshop';
        default:
            return 'a descrição do Workshop não informa o Mod ID';
    }
};

export const appendWorkshopResults = (current: WorkshopItem[], incoming: WorkshopItem[]): WorkshopItem[] =>
    Array.from(new Map([...current, ...incoming].map((item) => [item.workshopId, item])).values());

export const hasWorkshopChanges = (
    configuration: WorkshopConfiguration | undefined,
    workshopItems: string[],
    mods: string[]
): boolean =>
    !!configuration &&
    (JSON.stringify(workshopItems) !== JSON.stringify(configuration.workshopItems) ||
        JSON.stringify(mods) !== JSON.stringify(configuration.mods));

export const addWorkshopSelection = (
    workshopItems: string[],
    mods: string[],
    item: WorkshopItem
): { workshopItems: string[]; mods: string[] } => ({
    workshopItems: uniqueWorkshopValues([...workshopItems, item.workshopId]),
    mods: uniqueWorkshopValues([...mods, ...item.modIds]),
});

export const removeWorkshopSelection = (
    workshopItems: string[],
    mods: string[],
    workshopId: string,
    details: Map<string, WorkshopItem>
): { workshopItems: string[]; mods: string[] } => {
    const item = details.get(workshopId);
    const remainingItems = workshopItems.filter((id) => id !== workshopId);
    if (!item?.modIds.length) return { workshopItems: remainingItems, mods };

    const stillUsed = new Set(remainingItems.flatMap((id) => details.get(id)?.modIds || []));
    return {
        workshopItems: remainingItems,
        mods: mods.filter((id) => !item.modIds.includes(id) || stillUsed.has(id)),
    };
};
