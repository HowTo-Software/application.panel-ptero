<?php

namespace Pterodactyl\Tests\Unit\Services\HowToo;

use PHPUnit\Framework\TestCase;
use Pterodactyl\Services\HowToo\SteamWorkshopService;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;

class SteamWorkshopServiceTest extends TestCase
{
    private \ReflectionClass $reflection;
    private SteamWorkshopService $service;

    protected function setUp(): void
    {
        parent::setUp();
        $this->reflection = new \ReflectionClass(SteamWorkshopService::class);
        $this->service = $this->reflection->newInstanceWithoutConstructor();
    }

    public function testTextSearchParametersExposeIndependentPages(): void
    {
        $pageOne = $this->invoke('queryParameters', ['secret', 12, 'Authentic Z', 1, 30]);
        $pageTwo = $this->invoke('queryParameters', ['secret', 12, 'Authentic Z', 2, 30]);

        $this->assertSame(12, $pageOne['query_type']);
        $this->assertSame('Authentic Z', $pageOne['search_text']);
        $this->assertSame(1, $pageOne['page']);
        $this->assertSame(2, $pageTwo['page']);
        $this->assertSame(30, $pageTwo['numperpage']);
        $this->assertSame(108600, $pageTwo['appid']);
        $this->assertSame(108600, $pageTwo['creator_appid']);
    }

    public function testBrowseModesUseSteamQueryEnumsAndFilterWithRealAllowlistedTags(): void
    {
        $trending = $this->invoke('queryParameters', ['secret', 3, '', 1, 30, ['Build 42']]);
        $subscribed = $this->invoke('queryParameters', ['secret', 9, '', 1, 30]);
        $recent = $this->invoke('queryParameters', ['secret', 21, '', 1, 30]);
        $search = $this->invoke('queryParameters', ['secret', 12, 'common sense', 1, 30]);
        $build41 = $this->invoke('queryParameters', ['secret', 3, '', 1, 30, ['Build 41']]);

        $this->assertSame(3, $trending['query_type']);
        $this->assertSame(7, $trending['days']);
        $this->assertSame('Build 42', $trending['requiredtags']);
        $this->assertSame('Build 41', $build41['requiredtags']);
        $this->assertTrue($trending['match_all_tags']);
        $this->assertSame(9, $subscribed['query_type']);
        $this->assertSame(21, $recent['query_type']);
        $this->assertSame(12, $search['query_type']);
        $this->assertSame('common sense', $search['search_text']);
    }

    public function testWorkshopTransformReturnsOnlyRealSteamMetadata(): void
    {
        $resolver = new ProjectZomboidModIdResolver(
            \Mockery::mock(\Pterodactyl\Repositories\Wings\DaemonFileRepository::class),
            \Mockery::mock(\Illuminate\Contracts\Cache\Repository::class),
        );
        $this->reflection->getProperty('modIds')->setValue($this->service, $resolver);
        $item = $this->invoke('transform', [[
            'publishedfileid' => '123',
            'title' => 'Test mod',
            'tags' => [['tag' => 'Build 42']],
            'vote_data' => ['score' => 0.9, 'votes_up' => 9, 'votes_down' => 1],
            'subscriptions' => 1200,
            'creator' => '76561198000000000',
        ]]);

        $this->assertSame(['Build 42'], $item['tags']);
        $this->assertSame(0.9, $item['score']);
        $this->assertSame(9, $item['votes_up']);
        $this->assertSame(1, $item['votes_down']);
        $this->assertSame(1200, $item['subscriptions']);
        $this->assertNull($this->invoke('transform', [['publishedfileid' => '124']])['score']);
    }

    public function testTagNormalizationUsesOnlyTheSteamWorkshopAllowlist(): void
    {
        $this->assertSame(
            ['Build 42', 'Animals'],
            $this->invoke('normalizeTags', [['Build 42', 'untrusted tag', 'Animals', 'Build 42']]),
        );
    }

    public function testPaginationIncludesTotalPagesAndHasNext(): void
    {
        $pageOne = $this->invoke('result', [[['workshop_id' => '1']], 101, 1, 30, false]);
        $pageFour = $this->invoke('result', [[['workshop_id' => '101']], 101, 4, 30, false]);

        $this->assertSame(101, $pageOne['pagination']['total']);
        $this->assertSame(4, $pageOne['pagination']['total_pages']);
        $this->assertTrue($pageOne['pagination']['has_next']);
        $this->assertFalse($pageFour['pagination']['has_next']);
        $this->assertNotSame($pageOne['items'], $pageFour['items']);
    }

    public function testPaginationDoesNotStopAtTheFormerPageLimit(): void
    {
        $page = $this->invoke('result', [[['workshop_id' => '50000']], 50100, 1000, 50, false]);
        $parameters = $this->invoke('queryParameters', ['secret', 12, 'late catalog item', 1001, 50]);

        $this->assertTrue($page['pagination']['has_next']);
        $this->assertSame(1001, $parameters['page']);
    }

    public function testNumericIdAndWorkshopUrlResolveDirectly(): void
    {
        $this->assertSame('2785484298', $this->invoke('directWorkshopId', ['2785484298']));
        $this->assertSame('2785484298', $this->invoke('directWorkshopId', [
            'https://steamcommunity.com/sharedfiles/filedetails/?id=2785484298&searchtext=test',
        ]));
        $this->assertNull($this->invoke('directWorkshopId', [
            'https://steamcommunity.com/sharedfiles/filedetails/?searchtext=test',
        ]));
    }

    public function testExactTitleRanksFirstWithoutControllingPagination(): void
    {
        $items = [
            ['workshop_id' => '1', 'name' => 'Popular Tintin Collection', 'description' => 'Tintin content'],
            ['workshop_id' => '2', 'name' => 'Other Mod', 'description' => 'Includes support for Tintin'],
            ['workshop_id' => '3', 'name' => 'Tintin', 'description' => 'Exact result'],
            ['workshop_id' => '4', 'name' => 'Tintin Expanded', 'description' => 'Starts with the query'],
        ];

        $ranked = $this->invoke('rankResults', [$items, 'tintin']);

        $this->assertSame(['3', '4', '1', '2'], array_column($ranked, 'workshop_id'));
        $this->assertFalse($this->reflection->hasConstant('SEARCH_PAGE_DEPTH'));
        $this->assertFalse($this->reflection->hasConstant('SEARCH_RESULT_LIMIT'));
    }

    public function testPublishedFileFilteringUsesAnAritySafeCallback(): void
    {
        $source = file_get_contents($this->reflection->getFileName());
        $filtered = collect([['publishedfileid' => '1'], 'invalid'])
            ->filter(fn ($item): bool => is_array($item))
            ->values()
            ->all();

        $this->assertIsString($source);
        $this->assertStringNotContainsString("->filter('is_array')", $source);
        $this->assertStringContainsString('->filter(fn ($item): bool => is_array($item))', $source);
        $this->assertSame([['publishedfileid' => '1']], $filtered);
    }


    public function testCollectionChildrenKeepsWorkshopOrderAndRemovesDuplicates(): void
    {
        $payload = [
            'response' => [
                'collectiondetails' => [[
                    'publishedfileid' => '3730991494',
                    'result' => 1,
                    'children' => [
                        ['publishedfileid' => '123', 'sortorder' => 0],
                        ['publishedfileid' => '456', 'sortorder' => 1],
                        ['publishedfileid' => '123', 'sortorder' => 2],
                        ['publishedfileid' => '../invalid', 'sortorder' => 3],
                    ],
                ]],
            ],
        ];

        $this->assertSame(['123', '456'], $this->invoke('collectionChildren', [$payload, '3730991494']));
    }

    public function testCollectionResponseRejectsForeignOrMissingCollection(): void
    {
        $this->expectException(\Pterodactyl\Exceptions\DisplayException::class);
        $this->invoke('collectionChildren', [[
            'response' => ['collectiondetails' => [
                ['publishedfileid' => '999', 'result' => 1, 'children' => []],
            ]],
        ], '3730991494']);
    }

    public function testCollectionRejectsOverFiveHundredItemsWithoutSilentlyTruncating(): void
    {
        $this->expectException(\Pterodactyl\Exceptions\DisplayException::class);
        $children = [];
        for ($index = 0; $index <= 500; $index++) {
            $children[] = ['publishedfileid' => (string) ($index + 1)];
        }

        $this->invoke('collectionChildren', [[
            'response' => ['collectiondetails' => [[
                'publishedfileid' => '3730991494',
                'result' => 1,
                'children' => $children,
            ]]],
        ], '3730991494']);
    }

    public function testTransformedWorkshopDetailsExposeAppAndTypeOnlyForInternalFiltering(): void
    {
        $resolver = new ProjectZomboidModIdResolver(
            \Mockery::mock(\Pterodactyl\Repositories\Wings\DaemonFileRepository::class),
            \Mockery::mock(\Illuminate\Contracts\Cache\Repository::class),
        );
        $this->reflection->getProperty('modIds')->setValue($this->service, $resolver);

        $item = $this->invoke('transform', [[
            'publishedfileid' => '3730991494',
            'file_type' => 2,
            'consumer_app_id' => 108600,
        ]]);
        $this->assertSame(2, $item['file_type']);
        $this->assertSame(108600, $item['consumer_app_id']);
    }

    private function invoke(string $method, array $arguments): mixed
    {
        $reflection = $this->reflection->getMethod($method);
        $reflection->setAccessible(true);

        return $reflection->invokeArgs($this->service, $arguments);
    }
}
