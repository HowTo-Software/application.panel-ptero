import {
    addWorkshopSelection,
    appendWorkshopResults,
    hasWorkshopChanges,
    parseManualModIds,
    removeWorkshopSelection,
    toggleWorkshopModId,
    withManualModIds,
} from './workshopSelection';
import { WorkshopConfiguration, WorkshopItem } from '@/api/server/howtoo';

const item = (workshopId: string, modIds: string[]): WorkshopItem => ({
    workshopId,
    modIds,
    name: `Item ${workshopId}`,
    image: null,
    description: '',
    modIdSource: null,
    tags: [],
    score: null,
    votesUp: null,
    votesDown: null,
    subscriptions: null,
    creatorId: null,
    updatedAt: null,
});

const configuration: WorkshopConfiguration = {
    path: '/.cache/Server/Test.ini',
    revision: 'one',
    workshopItems: ['1'],
    mods: ['Shared'],
    details: [],
    detailsError: null,
};

describe('Workshop selection state', () => {
    it('ADD marks configuration dirty and prevents duplicates', () => {
        const added = addWorkshopSelection(['1'], ['Shared'], item('2', ['Shared', 'Second']));

        expect(added).toEqual({ workshopItems: ['1', '2'], mods: ['Shared', 'Second'] });
        expect(hasWorkshopChanges(configuration, added.workshopItems, added.mods)).toBe(true);
    });

    it('REMOVE marks configuration dirty but preserves Mod IDs still used by another item', () => {
        const details = new Map([
            ['1', item('1', ['Shared'])],
            ['2', item('2', ['Shared', 'Second'])],
        ]);
        const removed = removeWorkshopSelection(['1', '2'], ['Shared', 'Second'], '2', details);

        expect(removed).toEqual({ workshopItems: ['1'], mods: ['Shared'] });
        expect(
            hasWorkshopChanges(
                { ...configuration, workshopItems: ['1', '2'], mods: ['Shared', 'Second'] },
                removed.workshopItems,
                removed.mods
            )
        ).toBe(true);
    });

    it('Load More deduplicates by Workshop ID while keeping the latest item data', () => {
        const merged = appendWorkshopResults(
            [item('1', [])],
            [{ ...item('1', ['Resolved']), name: 'Updated' }, item('2', [])]
        );

        expect(merged.map(({ workshopId }) => workshopId)).toEqual(['1', '2']);
        expect(merged[0].modIds).toEqual(['Resolved']);
    });

    it('becomes clean after the saved configuration matches the pending selection', () => {
        const saved = { ...configuration, workshopItems: ['1', '2'], mods: ['Shared', 'Second'] };

        expect(hasWorkshopChanges(saved, saved.workshopItems, saved.mods)).toBe(false);
    });

    it('an item without detected Mod IDs can still be added to WorkshopItems', () => {
        expect(addWorkshopSelection(['1'], ['Shared'], item('2', []))).toEqual({
            workshopItems: ['1', '2'],
            mods: ['Shared'],
        });
    });

    it('manual Mod IDs are trimmed, deduplicated and lose the B42 backslash prefix', () => {
        expect(parseManualModIds(' Alpha; \\Beta;;Alpha ; [J&G] SWAT Uniform ')).toEqual([
            'Alpha',
            'Beta',
            '[J&G] SWAT Uniform',
        ]);
        expect(withManualModIds(item('2', []), ['Typed']).modIds).toEqual(['Typed']);
        expect(withManualModIds(item('2', ['Known']), undefined).modIds).toEqual(['Known']);
    });

    it('toggling a Mod ID activates or deactivates it without touching the others', () => {
        expect(toggleWorkshopModId(['A', 'B'], 'B')).toEqual(['A']);
        expect(toggleWorkshopModId(['A'], 'B')).toEqual(['A', 'B']);
    });
});
