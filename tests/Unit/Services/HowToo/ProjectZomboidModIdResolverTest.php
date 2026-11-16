<?php

namespace Pterodactyl\Tests\Unit\Services\HowToo;

use Pterodactyl\Models\Server;
use PHPUnit\Framework\TestCase;
use Pterodactyl\Repositories\Wings\DaemonFileRepository;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;
use Illuminate\Contracts\Cache\Repository as CacheRepository;

class ProjectZomboidModIdResolverTest extends TestCase
{
    private ProjectZomboidModIdResolver $resolver;

    protected function setUp(): void
    {
        parent::setUp();

        $this->resolver = new ProjectZomboidModIdResolver(
            \Mockery::mock(DaemonFileRepository::class),
            \Mockery::mock(CacheRepository::class),
        );
    }

    protected function tearDown(): void
    {
        \Mockery::close();
        parent::tearDown();
    }

    public function testItReadsExactIdsFromMultipleModInfoFiles(): void
    {
        $this->assertSame(['CommonSense'], $this->resolver->parseModInfo(implode("\n", [
            'name=Common Sense',
            'id=CommonSense',
            'description=id=NotASecondId',
        ])));

        $this->assertSame(['CommonSenseFix'], $this->resolver->parseModInfo("id = CommonSenseFix\nposter=poster.png"));
    }

    public function testPreservesPublishedIdsWithSpacesAndPunctuation(): void
    {
        $this->assertSame(
            ['[J&G] SWAT Uniform', "GanydeBielovzki's Frockin Stompers!"],
            $this->resolver->parseModInfo("\xEF\xBB\xBFid=[J&G] SWAT Uniform\r\nid=GanydeBielovzki's Frockin Stompers!\r\n"),
        );
    }

    public function testMergesMultipleDeclaredIdsWithoutDuplicates(): void
    {
        $result = $this->resolver->resolveSteamItem([
            'metadata' => json_encode(['modIds' => ['Alpha', 'Beta']]),
            'raw_description' => '[b]Mod ID:[/b] Beta<br>Mod ID: [J&G] SWAT Uniform',
        ]);

        $this->assertSame(['Alpha', 'Beta', '[J&G] SWAT Uniform'], $result['mod_ids']);
    }

    public function testItUsesStructuredSteamMetadataBeforeDescription(): void
    {
        $item = [
            'metadata' => json_encode(['modIds' => 'CommonSense;CommonSenseFix']),
            'kv_tags' => [['key' => 'category', 'value' => 'Balance']],
        ];

        $this->assertSame(['CommonSense', 'CommonSenseFix'], $this->resolver->fromSteamMetadata($item));
    }

    public function testDescriptionFallbackRequiresAnExplicitModIdLabel(): void
    {
        $this->assertSame(
            ['CommonSense', 'CommonSenseFix'],
            $this->resolver->fromDescription("Workshop ID: 123\nMod IDs: CommonSense;CommonSenseFix"),
        );
        $this->assertSame([], $this->resolver->fromDescription('CommonSense is a quality-of-life mod.'));
    }

    public function testItFindsEveryModInfoInsideAnInstalledWorkshopItem(): void
    {
        $server = \Mockery::mock(Server::class)->makePartial();
        $server->setRawAttributes(['uuid' => 'server-uuid']);
        $files = \Mockery::mock(DaemonFileRepository::class);
        $cache = \Mockery::mock(CacheRepository::class);
        $root = '/.cache/Steam/steamapps/workshop/content/108600';

        $cache->shouldReceive('get')->once()->with('howtoo:pz-mod-ids:server-uuid:123')->andReturnNull();
        $cache->shouldReceive('put')->once()->with(
            'howtoo:pz-mod-ids:server-uuid:123',
            ['CommonSense', 'CommonSenseFix'],
            \Mockery::type(\DateTimeInterface::class),
        );
        $files->shouldReceive('setServer')->once()->with($server)->andReturnSelf();
        $files->shouldReceive('getDirectory')->once()->with($root)->andReturn([
            ['name' => '123', 'file' => false, 'symlink' => false],
        ]);
        $files->shouldReceive('getDirectory')->once()->with("$root/123")->andReturn([
            ['name' => 'mods', 'file' => false, 'symlink' => false],
        ]);
        $files->shouldReceive('getDirectory')->once()->with("$root/123/mods")->andReturn([
            ['name' => 'Main', 'file' => false, 'symlink' => false],
            ['name' => 'Fix', 'file' => false, 'symlink' => false],
        ]);
        $files->shouldReceive('getDirectory')->once()->with("$root/123/mods/Main")->andReturn([
            ['name' => 'mod.info', 'file' => true, 'symlink' => false],
        ]);
        $files->shouldReceive('getDirectory')->once()->with("$root/123/mods/Fix")->andReturn([
            ['name' => 'mod.info', 'file' => true, 'symlink' => false],
        ]);
        $files->shouldReceive('getContent')->once()->with("$root/123/mods/Main/mod.info", 256 * 1024)
            ->andReturn('id=CommonSense');
        $files->shouldReceive('getContent')->once()->with("$root/123/mods/Fix/mod.info", 256 * 1024)
            ->andReturn('id=CommonSenseFix');

        $resolver = new ProjectZomboidModIdResolver($files, $cache);

        $this->assertSame(
            ['123' => ['CommonSense', 'CommonSenseFix']],
            $resolver->resolveInstalled($server, ['123']),
        );
    }
}
