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

    public function testRealWorkshopDescriptionFormatsAreParsed(): void
    {
        // Shapes copied from live Project Zomboid Workshop pages.
        $this->assertSame(
            ['87fordB700'],
            $this->resolver->fromDescription("87fordF700bank, 87fordF700box\r\n\r\nWorkshop ID: 3110911330\r\nMod ID: 87fordB700"),
        );
        $this->assertSame(
            ['ZVirusVaccine42BETA', 'ResearchLabInternProfession'],
            $this->resolver->fromDescription("[hr][/hr]\r\n\u{1F194} Workshop ID: 3615135168\r\n\u{1F194} Mod ID: ZVirusVaccine42BETA\r\n\u{1F194} Mod ID: ResearchLabInternProfession"),
        );
    }

    public function testDescriptionLabelsAcceptQualifiersHeadingsAndSeparators(): void
    {
        $this->assertSame(['Alpha', 'Beta'], $this->resolver->fromDescription("[h2]Mod ID[/h2]\nAlpha\nBeta\n\nOther text"));
        $this->assertSame(['Alpha'], $this->resolver->fromDescription("Mod ID:\r\nAlpha\r\nWorkshop ID: 123"));
        $this->assertSame(
            ['Alpha42', 'Alpha41', 'Gamma'],
            $this->resolver->fromDescription("Mod ID (B42): Alpha42\nMod ID [B41]: Alpha41\nMod ID for B42: Gamma"),
        );
        $this->assertSame(['Alpha'], $this->resolver->fromDescription('Mod ID: Alpha / Workshop ID: 123'));
        $this->assertSame(['Alpha', 'Beta', 'Gamma', 'Delta'], $this->resolver->fromDescription('Mod IDs: Alpha; Beta, Gamma | Delta'));
        $this->assertSame(['Alpha'], $this->resolver->fromDescription('Mod ID: Alpha (B42 only)'));
        $this->assertSame(['TableMod'], $this->resolver->fromDescription('[table][tr][td]Mod ID[/td][td]TableMod[/td][/tr][/table]'));
        $this->assertSame(["'87Trucks"], $this->resolver->fromDescription("Mod ID: '87Trucks"));
    }

    public function testInlineDependencyMentionsOnlyApplyWithoutALineLabel(): void
    {
        $this->assertSame(['RealMod'], $this->resolver->fromDescription("Requires Tsar Lib (Mod ID: tsarslib)\nMod ID: RealMod"));
        $this->assertSame(['tsarslib'], $this->resolver->fromDescription('Requires Tsar Lib (Mod ID: tsarslib)'));
    }

    public function testDescriptionRejectsProseAndLinks(): void
    {
        $this->assertSame(['Real'], $this->resolver->fromDescription("Mod IDs are case-sensitive: copy them exactly\nMod ID: Real"));
        $this->assertSame([], $this->resolver->fromDescription('Mod ID: https://steamcommunity.com/sharedfiles/filedetails/?id=1'));
        $this->assertSame([], $this->resolver->fromDescription('Modified: today'));
    }

    public function testModInfoWithCrlfAndUtf16IsRead(): void
    {
        $this->assertSame(['Animalsdonotattackbuildings'], $this->resolver->parseModInfo("name=X\r\nid=Animalsdonotattackbuildings \r\nicon=icon.png\r\n"));
        $this->assertSame(['Utf16Mod'], $this->resolver->parseModInfo("\xFF\xFE" . mb_convert_encoding("id=Utf16Mod\r\n", 'UTF-16LE', 'UTF-8')));
    }

    public function testItFindsEveryModInfoInsideAnInstalledWorkshopItem(): void
    {
        $server = \Mockery::mock(Server::class)->makePartial();
        $server->setRawAttributes(['uuid' => 'server-uuid']);
        $files = \Mockery::mock(DaemonFileRepository::class);
        $cache = \Mockery::mock(CacheRepository::class);
        $root = '/.cache/Steam/steamapps/workshop/content/108600';

        $cache->shouldReceive('get')->once()->with('howtoo:pz-mod-ids:v2:server-uuid:123')->andReturnNull();
        $cache->shouldReceive('put')->once()->with(
            'howtoo:pz-mod-ids:v2:server-uuid:123',
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
