<?php

namespace Pterodactyl\Jobs;

use Illuminate\Support\Facades\Cache;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;

class ResolveWorkshopModIds implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;
    public int $timeout = 85;

    public function __construct(
        public readonly string $cacheKey,
        public readonly ?string $manifest,
        public readonly ?string $url,
    ) {
    }

    public function handle(ProjectZomboidModIdResolver $resolver): void
    {
        $ids = $resolver->inspectPublishedFiles($this->manifest, $this->url);
        if ($ids === []) {
            $this->failed();

            return;
        }

        Cache::put($this->cacheKey, ['state' => 'complete', 'ids' => $ids], now()->addDays(7));
    }

    public function failed(): void
    {
        Cache::put($this->cacheKey, ['state' => 'unavailable'], now()->addMinutes(30));
    }
}
