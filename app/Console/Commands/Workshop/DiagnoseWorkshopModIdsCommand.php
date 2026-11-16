<?php

namespace Pterodactyl\Console\Commands\Workshop;

use Pterodactyl\Models\Server;
use Illuminate\Console\Command;
use Pterodactyl\Exceptions\DisplayException;
use Pterodactyl\Services\HowToo\SteamWorkshopService;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;

/**
 * Shows every Mod ID source for one Workshop item so a failing detection can be
 * explained without guessing: php artisan p:workshop:diagnose 3110911330 --download.
 */
class DiagnoseWorkshopModIdsCommand extends Command
{
    protected $signature = 'p:workshop:diagnose
        {workshop_id : Steam Workshop item ID}
        {--server= : Server UUID or short ID whose installed files should also be scanned}
        {--download : Run the mod.info download synchronously instead of reading the queue cache}';

    protected $description = 'Explains how the panel detects (or fails to detect) the Project Zomboid Mod IDs of a Workshop item.';

    public function handle(SteamWorkshopService $steam, ProjectZomboidModIdResolver $resolver): int
    {
        $workshopId = (string) $this->argument('workshop_id');
        if (preg_match('/^\d{1,20}$/D', $workshopId) !== 1) {
            $this->error('The Workshop ID must be numeric.');

            return self::FAILURE;
        }

        try {
            $item = $steam->details([$workshopId])[0] ?? null;
        } catch (DisplayException $exception) {
            $this->error('Steam details: ' . $exception->getMessage());

            return self::FAILURE;
        }
        if (!$item) {
            $this->error('Steam did not return this item (private, deleted or invalid).');

            return self::FAILURE;
        }

        $downloader = (string) config('howtoo.workshop.downloader');
        $this->table(['Field', 'Value'], [
            ['Title', $item['name']],
            ['App', $item['consumer_app_id'] . ($steam->isProjectZomboidItem($item) ? ' (Project Zomboid)' : ' (NOT a Project Zomboid mod)')],
            ['Content manifest', $item['content_manifest'] ?: '-'],
            ['Legacy file URL', $item['content_url'] ?: '-'],
            ['Description length', mb_strlen((string) $item['raw_description'])],
            ['Downloader', $downloader . ($resolver->downloaderAvailable() ? ' (executable)' : ' (MISSING or not executable)')],
            ['Queue connection', config('queue.default') . ' / queue "' . config('howtoo.workshop.queue', 'workshop') . '"'],
        ]);

        $steamIds = $resolver->resolveSteamItem($item);
        $this->line('Steam metadata ids: ' . $this->ids($resolver->fromSteamMetadata($item)));
        $this->line('Description ids:    ' . $this->ids($resolver->fromDescription((string) $item['raw_description'])));

        if ($this->option('download')) {
            $manifest = $resolver->downloaderAvailable() ? $resolver->manifestId($item) : null;
            $this->line('Downloading mod.info files...');
            $remote = $resolver->inspectPublishedFiles($manifest, $resolver->archiveUrl($item));
            $this->line('Published files:    ' . $this->ids($remote['ids']));
            if ($remote['error']) {
                $this->warn('Download error: ' . $remote['error']);
            }
        } else {
            $state = $resolver->remoteState($item);
            $this->line('Queue cache state:  ' . ($state === null ? 'none' : json_encode($state, JSON_UNESCAPED_SLASHES)));
        }

        $installed = [];
        if ($serverId = $this->option('server')) {
            $server = Server::query()->where('uuid', $serverId)->orWhere('uuidShort', $serverId)->first();
            if (!$server) {
                $this->error("Server $serverId was not found.");

                return self::FAILURE;
            }
            $resolver->forgetInstalled($server, [$workshopId]);
            $installed = $resolver->resolveInstalled($server, [$workshopId])[$workshopId] ?? [];
            $this->line('Installed mod.info: ' . $this->ids($installed));
        }

        $final = $resolver->resolveItem($item, $installed, queue: false);
        $this->newLine();
        $this->info(sprintf(
            'Panel result: %s (source: %s%s)',
            $this->ids($final['mod_ids']),
            $final['mod_id_source'] ?? 'none',
            $final['mod_id_reason'] ? ', reason: ' . $final['mod_id_reason'] : '',
        ));

        return $final['mod_ids'] === [] && $steamIds['mod_ids'] === [] ? self::FAILURE : self::SUCCESS;
    }

    private function ids(array $ids): string
    {
        return $ids === [] ? '(none)' : implode('; ', $ids);
    }
}
