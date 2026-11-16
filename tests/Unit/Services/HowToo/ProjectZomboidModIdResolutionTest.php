<?php

namespace Pterodactyl\Tests\Unit\Services\HowToo;

use Pterodactyl\Tests\TestCase;
use Illuminate\Cache\ArrayStore;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;
use Pterodactyl\Jobs\ResolveWorkshopModIds;
use Illuminate\Cache\Repository as CacheRepository;
use Pterodactyl\Repositories\Wings\DaemonFileRepository;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;

/**
 * Source priority of resolveItem(). The production failure was a failed or
 * never-processed mod.info download replacing Mod IDs that the Workshop
 * description already declared, so every item showed "Mod IDs unavailable".
 */
class ProjectZomboidModIdResolutionTest extends TestCase
{
    private CacheRepository $cache;
    private ProjectZomboidModIdResolver $resolver;
    private string $downloader;

    public function setUp(): void
    {
        parent::setUp();

        $this->cache = new CacheRepository(new ArrayStore());
        Cache::swap($this->cache);
        Queue::fake();
        // Any existing executable makes the downloader "available"; it is never run here.
        $this->downloader = PHP_BINARY;
        config()->set('howtoo.workshop.downloader', $this->downloader);
        config()->set('howtoo.workshop.queue', 'workshop');
        $this->resolver = new ProjectZomboidModIdResolver(\Mockery::mock(DaemonFileRepository::class), $this->cache);
    }

    protected function tearDown(): void
    {
        \Mockery::close();
        parent::tearDown();
    }

    public function testDescriptionIdsAreReturnedWithoutQueueingADownload(): void
    {
        $result = $this->resolver->resolveItem($this->item("Workshop ID: 1\nMod ID: FruityFarmer"));

        $this->assertSame(['FruityFarmer'], $result['mod_ids']);
        $this->assertSame('workshop_description', $result['mod_id_source']);
        $this->assertFalse($result['mod_id_pending']);
        Queue::assertNothingPushed();
    }

    public function testAFailedDownloadNeverErasesDescriptionIds(): void
    {
        $item = $this->item('Mod ID: FruityFarmer');
        $this->cache->put($this->resolver->publishedCacheKey($item), ['state' => 'unavailable', 'error' => 'boom'], 60);

        $this->assertSame(['FruityFarmer'], $this->resolver->resolveItem($item)['mod_ids']);
    }

    public function testAQueuedDownloadNeverHidesDescriptionIds(): void
    {
        $item = $this->item('Mod ID: FruityFarmer');
        $this->cache->put($this->resolver->publishedCacheKey($item), ['state' => 'queued', 'queued_at' => time()], 60);

        $result = $this->resolver->resolveItem($item);

        $this->assertSame(['FruityFarmer'], $result['mod_ids']);
        $this->assertFalse($result['mod_id_pending']);
    }

    public function testPublishedModInfoOverridesTheDescription(): void
    {
        $item = $this->item('Mod ID: OldName');
        $this->cache->put($this->resolver->publishedCacheKey($item), ['state' => 'complete', 'ids' => ['RealName']], 60);

        $result = $this->resolver->resolveItem($item);

        $this->assertSame(['RealName'], $result['mod_ids']);
        $this->assertSame('remote_mod_info', $result['mod_id_source']);
    }

    public function testInstalledModInfoOverridesEverything(): void
    {
        $result = $this->resolver->resolveItem($this->item('Mod ID: OldName'), ['Installed']);

        $this->assertSame(['Installed'], $result['mod_ids']);
        $this->assertSame('mod_info', $result['mod_id_source']);
    }

    public function testItemsWithoutDescriptionIdsAreQueuedOnTheWorkshopQueue(): void
    {
        $result = $this->resolver->resolveItem($this->item('No ids here.'));

        $this->assertSame([], $result['mod_ids']);
        $this->assertTrue($result['mod_id_pending']);
        Queue::assertPushedOn('workshop', ResolveWorkshopModIds::class);
    }

    public function testAQueueWithoutWorkersIsReportedInsteadOfPendingForever(): void
    {
        $item = $this->item('No ids here.');
        $this->cache->put($this->resolver->publishedCacheKey($item), ['state' => 'queued', 'queued_at' => time() - 3600], 60);

        $result = $this->resolver->resolveItem($item);

        $this->assertFalse($result['mod_id_pending']);
        $this->assertSame(ProjectZomboidModIdResolver::REASON_QUEUE_STALLED, $result['mod_id_reason']);
    }

    public function testMissingDownloaderIsReported(): void
    {
        config()->set('howtoo.workshop.downloader', '/nonexistent/hts-workshop-download');

        $result = $this->resolver->resolveItem($this->item('No ids here.'));

        $this->assertFalse($result['mod_id_pending']);
        $this->assertSame(ProjectZomboidModIdResolver::REASON_DOWNLOADER_UNAVAILABLE, $result['mod_id_reason']);
        Queue::assertNothingPushed();
    }

    public function testFailedInspectionIsReported(): void
    {
        $item = $this->item('No ids here.');
        $this->cache->put($this->resolver->publishedCacheKey($item), ['state' => 'unavailable', 'error' => 'boom'], 60);

        $result = $this->resolver->resolveItem($item);

        $this->assertSame(ProjectZomboidModIdResolver::REASON_INSPECTION_FAILED, $result['mod_id_reason']);
    }

    public function testJobRecordsTheFailureReason(): void
    {
        $item = $this->item('No ids here.');
        $key = $this->resolver->publishedCacheKey($item);

        (new ResolveWorkshopModIds($key, null, null))->handle($this->resolver);

        $state = $this->cache->get($key);
        $this->assertSame('unavailable', $state['state']);
        $this->assertNotEmpty($state['error']);
    }

    private function item(string $description): array
    {
        return [
            'workshop_id' => '3781883471',
            'raw_description' => $description,
            'content_manifest' => '4371731658586523896',
            'content_url' => null,
            'updated_at' => 1,
        ];
    }
}
