<?php

namespace Pterodactyl\Tests\Unit\Services\HowToo;

use Illuminate\Support\Str;
use Pterodactyl\Models\Server;
use PHPUnit\Framework\TestCase;
use Pterodactyl\Facades\Activity;
use Illuminate\Support\Facades\Facade;
use Psr\Http\Message\ResponseInterface;
use Pterodactyl\Services\HowToo\ServerGameContext;
use Pterodactyl\Services\Activity\ActivityLogService;
use Pterodactyl\Services\HowToo\SteamWorkshopService;
use Pterodactyl\Repositories\Wings\DaemonFileRepository;
use Pterodactyl\Repositories\Wings\DaemonPowerRepository;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;
use Pterodactyl\Services\HowToo\ZomboidWorkshopConfigService;
use Pterodactyl\Http\Controllers\Api\Client\Servers\HowToo\WorkshopController;
use Pterodactyl\Http\Requests\Api\Client\Servers\HowToo\WorkshopUpdateRequest;

class WorkshopControllerTest extends TestCase
{
    protected function tearDown(): void
    {
        Facade::clearResolvedInstance(ActivityLogService::class);
        \Mockery::close();
        parent::tearDown();
    }

    public function testSaveAndRestartWritesConfigurationBeforeSendingPowerSignal(): void
    {
        $server = $this->projectZomboidServer();
        $path = '/.cache/Server/servertest.ini';
        $content = "WorkshopItems=\nMods=\n";
        $files = \Mockery::mock(DaemonFileRepository::class);
        $files->shouldReceive('setServer')->times(3)->with($server)->andReturnSelf();
        $files->shouldReceive('getContent')->twice()->with($path, 2 * 1024 * 1024)->andReturn($content);
        $files->shouldReceive('putContent')
            ->once()
            ->with($path, "WorkshopItems=\nMods=Alpha\n")
            ->globally()
            ->ordered()
            ->andReturn(\Mockery::mock(ResponseInterface::class));

        $power = \Mockery::mock(DaemonPowerRepository::class);
        $power->shouldReceive('setServer')->once()->with($server)->andReturnSelf();
        $power->shouldReceive('send')->once()->with('restart')->globally()->ordered()
            ->andReturn(\Mockery::mock(ResponseInterface::class));

        $activity = \Mockery::mock(ActivityLogService::class);
        $activity->shouldReceive('event')->twice()->andReturnSelf();
        $activity->shouldReceive('property')->twice()->andReturnSelf();
        $activity->shouldReceive('log')->twice();
        Activity::swap($activity);

        $request = \Mockery::mock(WorkshopUpdateRequest::class);
        $request->shouldReceive('input')->with('workshop_items')->andReturn([]);
        $request->shouldReceive('input')->with('mods')->andReturn(['Alpha']);
        $request->shouldReceive('input')->with('workshop_mods', [])->andReturn([]);
        $request->shouldReceive('input')->with('action')->andReturn('restart');
        $request->shouldReceive('string')->with('revision')->andReturn(Str::of(hash('sha256', $content)));

        $gameContext = new ServerGameContext();
        $controller = new WorkshopController(
            new ZomboidWorkshopConfigService($files, $gameContext),
            (new \ReflectionClass(SteamWorkshopService::class))->newInstanceWithoutConstructor(),
            (new \ReflectionClass(ProjectZomboidModIdResolver::class))->newInstanceWithoutConstructor(),
            $gameContext,
            $power,
        );

        $response = $controller->update($request, $server);
        $payload = json_decode($response->getContent(), true, flags: JSON_THROW_ON_ERROR);

        $this->assertTrue($payload['restarted']);
        $this->assertSame([], $payload['workshop_items']);
        $this->assertSame(['Alpha'], $payload['mods']);
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
