<?php

namespace Pterodactyl\Http\Controllers\Api\Client\Servers\HowToo;

use Pterodactyl\Models\Server;
use Illuminate\Http\JsonResponse;
use Pterodactyl\Facades\Activity;
use Pterodactyl\Exceptions\DisplayException;
use Pterodactyl\Services\HowToo\ServerGameContext;
use Pterodactyl\Services\HowToo\SteamWorkshopService;
use Pterodactyl\Repositories\Wings\DaemonPowerRepository;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;
use Pterodactyl\Services\HowToo\ZomboidWorkshopConfigService;
use Pterodactyl\Http\Controllers\Api\Client\ClientApiController;
use Pterodactyl\Exceptions\Http\Connection\DaemonConnectionException;
use Pterodactyl\Http\Requests\Api\Client\Servers\HowToo\WorkshopReadRequest;
use Pterodactyl\Http\Requests\Api\Client\Servers\HowToo\WorkshopSearchRequest;
use Pterodactyl\Http\Requests\Api\Client\Servers\HowToo\WorkshopUpdateRequest;
use Pterodactyl\Http\Requests\Api\Client\Servers\HowToo\WorkshopCollectionRequest;

class WorkshopController extends ClientApiController
{
    public function __construct(
        private ZomboidWorkshopConfigService $config,
        private SteamWorkshopService $steam,
        private ProjectZomboidModIdResolver $modIds,
        private ServerGameContext $gameContext,
        private DaemonPowerRepository $power,
    ) {
        parent::__construct();
    }

    public function index(WorkshopReadRequest $request, Server $server): JsonResponse
    {
        $configuration = $this->config->read($server);
        $configuration['details'] = [];
        $configuration['details_error'] = null;

        try {
            $items = $this->steam->details($configuration['workshop_items']);
            $installed = $this->modIds->resolveInstalled($server, $configuration['workshop_items']);
            $configuration['details'] = array_map(
                fn (array $item): array => $this->publicItem(array_replace(
                    $item,
                    $this->modIds->resolveItem($item, $installed[$item['workshop_id']] ?? [], queue: false)
                )),
                $items,
            );
        } catch (DisplayException $exception) {
            $configuration['details_error'] = $exception->getMessage();
        }

        return new JsonResponse($configuration);
    }

    public function search(WorkshopSearchRequest $request, Server $server): JsonResponse
    {
        if (!$this->gameContext->for($server)['project_zomboid']) {
            throw new DisplayException('Workshop Manager is only available for Project Zomboid servers.');
        }

        $mode = $request->string('mode', 'search')->toString();
        $page = $request->integer('page', 1);
        $perPage = $request->integer('per_page', 30);
        $tags = $request->input('tags', []);

        $results = $mode === 'search'
            ? $this->steam->search(
                $request->string('query')->toString(),
                $page,
                $perPage,
                $tags,
            )
            : $this->steam->browse($mode, $page, $perPage, $tags);

        $results['items'] = collect($results['items'])->map(fn (array $item): array => $this->publicItem($item))->all();

        return new JsonResponse($results);
    }

    public function collection(WorkshopCollectionRequest $request, Server $server): JsonResponse
    {
        if (!$this->gameContext->for($server)['project_zomboid']) {
            throw new DisplayException('Workshop Manager is only available for Project Zomboid servers.');
        }

        $result = $this->steam->collection($request->string('link')->toString());
        $installed = $this->modIds->resolveInstalled($server, array_column($result['items'], 'workshop_id'));
        $result['items'] = array_map(
            fn (array $item): array => $this->publicItem(array_replace(
                $item,
                $this->modIds->resolveItem($item, $installed[$item['workshop_id']] ?? [])
            )),
            $result['items'],
        );
        $result['unresolved_ids'] = collect($result['items'])
            ->filter(fn (array $item): bool => $item['mod_ids'] === [] && !$item['mod_id_pending'])
            ->pluck('workshop_id')
            ->values()
            ->all();

        return new JsonResponse($result);
    }

    public function resolve(WorkshopReadRequest $request, Server $server, string $workshopId): JsonResponse
    {
        if (!$this->gameContext->for($server)['project_zomboid']) {
            throw new DisplayException('Workshop Manager is only available for Project Zomboid servers.');
        }

        $item = $this->steam->details([$workshopId])[0] ?? null;
        if (!$item || $item['workshop_id'] !== $workshopId || !$this->steam->isProjectZomboidItem($item)) {
            throw new DisplayException('The selected Steam Workshop item could not be found.');
        }

        $installed = $this->modIds->resolveInstalled($server, [$workshopId]);

        return new JsonResponse($this->publicItem(array_replace(
            $item,
            $this->modIds->resolveItem($item, $installed[$workshopId] ?? [])
        )));
    }

    public function update(WorkshopUpdateRequest $request, Server $server): JsonResponse
    {
        $current = $this->config->read($server);
        $workshopItems = $request->input('workshop_items');
        [$mods, $unresolved] = $this->resolvedMods(
            $server,
            $workshopItems,
            $request->input('mods'),
            $request->input('workshop_mods', []),
            $current,
        );
        $configuration = $this->config->save(
            $server,
            $workshopItems,
            $mods,
            $request->string('revision')->toString(),
        );

        Activity::event('server:integration.workshop-update')
            ->property('workshop_items', $configuration['workshop_items'])
            ->property('mods', $configuration['mods'])
            ->log();

        $restarted = $request->input('action') === 'restart';
        $restartError = null;
        if ($restarted) {
            try {
                $this->power->setServer($server)->send('restart');
                Activity::event('server:power.restart')->log();
            } catch (DaemonConnectionException) {
                $restarted = false;
                $restartError = 'Changes were saved, but Wings could not restart the server.';
            }
        }

        return new JsonResponse(array_merge($configuration, [
            'restarted' => $restarted,
            'restart_error' => $restartError,
            'unresolved_workshop_items' => array_values(array_intersect($unresolved, $configuration['workshop_items'])),
        ]));
    }

    private function publicItem(array $item): array
    {
        return collect($item)->only([
            'workshop_id',
            'name',
            'image',
            'description',
            'mod_ids',
            'mod_id_source',
            'mod_id_pending',
            'mod_id_reason',
            'tags',
            'score',
            'votes_up',
            'votes_down',
            'subscriptions',
            'creator_id',
            'updated_at',
        ])->all();
    }

    /**
     * The submitted Mods list is the user's decision and is saved as-is, so a Mod ID
     * removed on purpose (an optional sub-mod, a B41 variant) is never put back.
     * Only Workshop items added in this save whose Mod IDs the browser did not know
     * yet are resolved here. An item that still cannot be resolved is saved anyway:
     * the game server downloads it on the next start, and the panel then reads the
     * ids from the installed mod.info files.
     *
     * @return array{0: string[], 1: string[]} the Mods list and the unresolved new Workshop IDs
     */
    private function resolvedMods(
        Server $server,
        array $workshopItems,
        array $submittedMods,
        array $workshopMods,
        array $current,
    ): array {
        $unknown = array_values(array_filter(
            array_diff($workshopItems, $current['workshop_items']),
            fn (string $workshopId): bool => ($workshopMods[$workshopId] ?? []) === [],
        ));
        if ($unknown === []) {
            return [$submittedMods, []];
        }

        $details = collect();
        try {
            $details = collect($this->steam->details($unknown))->keyBy('workshop_id');
        } catch (DisplayException) {
            // Installed mod.info files remain available when the Steam request fails.
        }
        $installed = $this->modIds->resolveInstalled($server, $unknown);
        $resolved = [];
        $unresolved = [];

        foreach ($unknown as $workshopId) {
            $modIds = $installed[$workshopId] ?? [];
            $item = $details->get($workshopId);
            if ($modIds === [] && is_array($item) && $this->steam->isProjectZomboidItem($item)) {
                $modIds = $this->modIds->resolveItem($item)['mod_ids'];
            }
            if ($modIds === []) {
                $unresolved[] = $workshopId;
            }
            $resolved = array_merge($resolved, $modIds);
        }

        $mods = array_values(array_unique(array_merge($submittedMods, $resolved)));
        if (count($mods) > 500) {
            throw new DisplayException('The Workshop configuration exceeds the limit of 500 Mod IDs.');
        }

        return [$mods, $unresolved];
    }
}
