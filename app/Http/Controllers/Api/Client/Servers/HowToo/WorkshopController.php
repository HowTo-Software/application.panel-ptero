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
            $configuration['details'] = $this->steam->details($configuration['workshop_items']);
            $installed = $this->modIds->resolveInstalled($server, $configuration['workshop_items']);
            $configuration['details'] = collect($configuration['details'])
                ->map(function (array $item) use ($installed): array {
                    $workshopId = $item['workshop_id'];
                    if (($installed[$workshopId] ?? []) !== []) {
                        $item['mod_ids'] = $installed[$workshopId];
                        $item['mod_id_source'] = 'mod_info';
                    } else {
                        $resolved = $this->modIds->resolveSteamItem($item);
                        if ($resolved['mod_ids'] !== []) {
                            $item['mod_ids'] = $resolved['mod_ids'];
                            $item['mod_id_source'] = $resolved['source'];
                        }
                    }

                    return $this->publicItem($item);
                })
                ->values()
                ->all();
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
        // Reuse the existing mod.info reader for any items already installed.
        // Bound batches preserve the resolver's 100 Workshop ID limit.
        $installed = [];
        foreach (array_chunk(array_column($result['items'], 'workshop_id'), 100) as $batch) {
            $installed = array_merge($installed, $this->modIds->resolveInstalled($server, $batch));
        }

        $result['items'] = collect($result['items'])
            ->map(function (array $item) use ($installed): array {
                if (($installed[$item['workshop_id']] ?? []) !== []) {
                    $item['mod_ids'] = $installed[$item['workshop_id']];
                    $item['mod_id_source'] = 'mod_info';
                }

                return $this->publicItem($item);
            })
            ->all();
        $result['unresolved_ids'] = collect($result['items'])
            ->filter(fn (array $item): bool => $item['mod_ids'] === [])
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
        if (!$item || $item['workshop_id'] !== $workshopId) {
            throw new DisplayException('The selected Steam Workshop item could not be found.');
        }

        $resolved = $this->modIds->resolve($server, $workshopId, $item);
        $item['mod_ids'] = $resolved['mod_ids'];
        $item['mod_id_source'] = $resolved['source'];

        return new JsonResponse($this->publicItem($item));
    }

    public function update(WorkshopUpdateRequest $request, Server $server): JsonResponse
    {
        $current = $this->config->read($server);
        $workshopItems = $request->input('workshop_items');
        $mods = $this->resolvedMods(
            $server,
            $workshopItems,
            $request->input('mods'),
            $request->input('workshop_mods'),
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
            'tags',
            'score',
            'votes_up',
            'votes_down',
            'subscriptions',
            'creator_id',
            'updated_at',
        ])->all();
    }

    private function resolvedMods(
        Server $server,
        array $workshopItems,
        array $submittedMods,
        array $workshopMods,
        array $current,
    ): array {
        if ($workshopItems === []) {
            return $submittedMods;
        }

        $details = collect();
        try {
            $details = collect($this->steam->details($workshopItems))->keyBy('workshop_id');
        } catch (DisplayException) {
            // Installed mod.info files and the explicit advanced fallback remain available.
        }
        $installed = $this->modIds->resolveInstalled($server, $workshopItems);
        $required = [];
        $unresolvedAdded = [];
        $added = array_diff($workshopItems, $current['workshop_items']);

        foreach ($workshopItems as $workshopId) {
            $modIds = $installed[$workshopId] ?? [];
            if ($modIds === [] && $details->has($workshopId)) {
                $modIds = $this->modIds->resolveSteamItem($details->get($workshopId))['mod_ids'];
            }
            if ($modIds === []) {
                $modIds = $workshopMods[$workshopId] ?? [];
            }

            if ($modIds === [] && in_array($workshopId, $added, true)) {
                $unresolvedAdded[] = $workshopId;
            }
            $required = array_merge($required, $modIds);
        }

        if ($unresolvedAdded !== []) {
            throw new DisplayException('A selected Workshop item has no resolvable Mod ID. Use the advanced Mod ID fallback before saving.');
        }

        return collect(array_merge($submittedMods, $required))
            ->map(fn ($id): string => trim((string) $id))
            ->filter()
            ->unique()
            ->values()
            ->all();
    }
}
