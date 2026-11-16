<?php

namespace Pterodactyl\Tests\Unit\Services\HowToo;

use Illuminate\Support\Str;
use GuzzleHttp\Psr7\Request;
use Pterodactyl\Models\Server;
use Pterodactyl\Tests\TestCase;
use Illuminate\Cache\ArrayStore;
use Pterodactyl\Facades\Activity;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Facade;
use Psr\Http\Message\ResponseInterface;
use GuzzleHttp\Exception\ConnectException;
use Illuminate\Contracts\Encryption\Encrypter;
use Pterodactyl\Services\HowToo\ServerGameContext;
use Illuminate\Cache\Repository as CacheRepository;
use Pterodactyl\Services\Activity\ActivityLogService;
use Pterodactyl\Services\HowToo\SteamWorkshopService;
use Pterodactyl\Repositories\Wings\DaemonFileRepository;
use Pterodactyl\Repositories\Wings\DaemonPowerRepository;
use Pterodactyl\Services\HowToo\IntegrationCredentialStore;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;
use Pterodactyl\Services\HowToo\ZomboidWorkshopConfigService;
use Pterodactyl\Exceptions\Http\Connection\DaemonConnectionException;
use Pterodactyl\Http\Controllers\Api\Client\Servers\HowToo\WorkshopController;
use Pterodactyl\Http\Requests\Api\Client\Servers\HowToo\WorkshopUpdateRequest;

class WorkshopControllerSaveTest extends TestCase
{
    private const PATH = '/.cache/Server/servertest.ini';

    public function setUp(): void
    {
        parent::setUp();

        config()->set('database.connections.workshop_save_test', ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']);
        DB::setDefaultConnection('workshop_save_test');
        config()->set('howtoo.providers.steam.enabled', false);
        config()->set('howtoo.workshop.downloader', '/nonexistent/hts-workshop-download');

        $activity = \Mockery::mock(ActivityLogService::class);
        $activity->shouldReceive('event')->andReturnSelf();
        $activity->shouldReceive('property')->andReturnSelf();
        $activity->shouldReceive('log');
        Activity::swap($activity);
    }

    protected function tearDown(): void
    {
        Facade::clearResolvedInstance(ActivityLogService::class);
        \Mockery::close();
        parent::tearDown();
    }

    public function testModIdsRemovedFromAnExistingItemAreNotPutBack(): void
    {
        $content = "WorkshopItems=1\nMods=Main;OptionalPatch\n";
        $files = $this->files($content, "WorkshopItems=1\nMods=Main\n");

        $payload = $this->save($files, $content, ['1'], ['Main'], ['1' => ['Main', 'OptionalPatch']]);

        $this->assertSame(['Main'], $payload['mods']);
        $this->assertSame([], $payload['unresolved_workshop_items']);
    }

    public function testANewItemWithoutDetectableModIdsIsSavedAndReported(): void
    {
        $content = "WorkshopItems=\nMods=\n";
        $files = $this->files($content, "WorkshopItems=9\nMods=\n");
        $files->shouldReceive('getDirectory')->andThrow(
            new DaemonConnectionException(new ConnectException('missing', new Request('GET', '/'))),
        );

        $payload = $this->save($files, $content, ['9'], [], []);

        $this->assertSame(['9'], $payload['workshop_items']);
        $this->assertSame([], $payload['mods']);
        $this->assertSame(['9'], $payload['unresolved_workshop_items']);
    }

    private function files(string $content, string $expected): DaemonFileRepository|\Mockery\MockInterface
    {
        $files = \Mockery::mock(DaemonFileRepository::class);
        $files->shouldReceive('setServer')->andReturnSelf();
        $files->shouldReceive('getContent')->with(self::PATH, 2 * 1024 * 1024)->andReturn($content);
        $files->shouldReceive('putContent')->once()->with(self::PATH, $expected)
            ->andReturn(\Mockery::mock(ResponseInterface::class));

        return $files;
    }

    private function save(DaemonFileRepository $files, string $content, array $items, array $mods, array $workshopMods): array
    {
        $request = \Mockery::mock(WorkshopUpdateRequest::class);
        $request->shouldReceive('input')->with('workshop_items')->andReturn($items);
        $request->shouldReceive('input')->with('mods')->andReturn($mods);
        $request->shouldReceive('input')->with('workshop_mods', [])->andReturn($workshopMods);
        $request->shouldReceive('input')->with('action')->andReturn('save');
        $request->shouldReceive('string')->with('revision')->andReturn(Str::of(hash('sha256', $content)));

        $resolver = new ProjectZomboidModIdResolver($files, new CacheRepository(new ArrayStore()));
        $gameContext = new ServerGameContext();
        $controller = new WorkshopController(
            new ZomboidWorkshopConfigService($files, $gameContext),
            new SteamWorkshopService(new IntegrationCredentialStore(\Mockery::mock(Encrypter::class)), $resolver),
            $resolver,
            $gameContext,
            \Mockery::mock(DaemonPowerRepository::class),
        );

        $response = null;
        DB::pretend(function () use ($controller, $request, &$response): void {
            $response = $controller->update($request, $this->projectZomboidServer());
        });

        return json_decode($response->getContent(), true, flags: JSON_THROW_ON_ERROR);
    }

    private function projectZomboidServer(): Server
    {
        $server = new Server();
        $server->uuid = 'test-server';
        $server->setRelation('egg', (object) ['name' => 'Project Zomboid', 'description' => '']);
        $server->setRelation('nest', (object) ['name' => 'Project Zomboid']);
        $server->setRelation('variables', collect());

        return $server;
    }
}
