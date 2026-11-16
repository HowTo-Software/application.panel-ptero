<?php

namespace Pterodactyl\Jobs;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Cache;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;

/**
 * Reads the mod.info files of one published Workshop item version and caches the ids.
 * The cache entry moves queued -> running -> complete|unavailable so the resolver can
 * tell a slow queue from a dead worker.
 */
class ResolveWorkshopModIds implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;
    public int $timeout = 100;

    public function __construct(
        public readonly string $cacheKey,
        public readonly ?string $manifest,
        public readonly ?string $url,
    ) {
    }

    public function handle(ProjectZomboidModIdResolver $resolver): void
    {
        Cache::put($this->cacheKey, ['state' => 'running', 'started_at' => time()], now()->addMinutes(20));

        $result = $resolver->inspectPublishedFiles($this->manifest, $this->url);
        if ($result['ids'] === []) {
            $this->markUnavailable($result['error'] ?? 'No mod.info was found in the published files.');

            return;
        }

        Cache::put($this->cacheKey, ['state' => 'complete', 'ids' => $result['ids']], now()->addDays(7));
    }

    public function failed(?\Throwable $exception = null): void
    {
        $this->markUnavailable($exception?->getMessage() ?? 'The inspection job failed.');
    }

    private function markUnavailable(string $error): void
    {
        Log::warning('Workshop Mod ID inspection failed.', [
            'cache_key' => $this->cacheKey,
            'manifest' => $this->manifest,
            'error' => $error,
        ]);

        Cache::put($this->cacheKey, [
            'state' => 'unavailable',
            'error' => mb_substr($error, 0, 2000),
            'failed_at' => time(),
        ], now()->addMinutes(30));
    }
}
