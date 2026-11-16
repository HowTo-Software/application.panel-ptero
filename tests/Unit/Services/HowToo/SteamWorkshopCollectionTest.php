<?php

namespace Pterodactyl\Tests\Unit\Services\HowToo;

use Pterodactyl\Tests\TestCase;
use Illuminate\Cache\ArrayStore;
use Illuminate\Support\Facades\DB;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Cache;
use Pterodactyl\Exceptions\DisplayException;
use Illuminate\Contracts\Encryption\Encrypter;
use PHPUnit\Framework\Attributes\DataProvider;
use Illuminate\Cache\Repository as CacheRepository;
use Pterodactyl\Services\HowToo\SteamWorkshopService;
use Pterodactyl\Repositories\Wings\DaemonFileRepository;
use Pterodactyl\Services\HowToo\IntegrationCredentialStore;
use Pterodactyl\Services\HowToo\ProjectZomboidModIdResolver;

class SteamWorkshopCollectionTest extends TestCase
{
    private const COLLECTION_ID = '3730991494';
    private SteamWorkshopService $service;

    public function setUp(): void
    {
        parent::setUp();

        config()->set('howtoo.providers.steam', [
            'enabled' => true,
            'secret' => 'test-steam-key',
            'base_url' => 'https://steam.test',
        ]);
        config()->set('database.connections.workshop_collection_test', [
            'driver' => 'sqlite',
            'database' => ':memory:',
            'prefix' => '',
        ]);
        DB::setDefaultConnection('workshop_collection_test');
        $cache = new CacheRepository(new ArrayStore());
        Cache::swap($cache);
        Http::swap(new Factory());
        Http::preventStrayRequests();

        $this->service = new SteamWorkshopService(
            new IntegrationCredentialStore(\Mockery::mock(Encrypter::class)),
            new ProjectZomboidModIdResolver(\Mockery::mock(DaemonFileRepository::class), $cache),
        );
    }

    protected function tearDown(): void
    {
        \Mockery::close();
        parent::tearDown();
    }

    public function testPublicCollectionImportsWhenPublishedFileDetailsOmitFileType(): void
    {
        // GetPublishedFileDetails returns result/app/title, but no file_type,
        // for the public PZIN collection as well as its individual mods.
        $this->fakeSteam([
            ['publishedfileid' => '200', 'filetype' => 0],
            ['publishedfileid' => '100', 'filetype' => 0],
            ['publishedfileid' => '200', 'filetype' => 0],
            ['publishedfileid' => '300', 'filetype' => 0],
            ['publishedfileid' => '400', 'filetype' => 0],
            ['publishedfileid' => '500', 'filetype' => 2],
        ], [
            '100' => $this->publishedFile('100'),
            '200' => $this->publishedFile('200'),
            '300' => ['publishedfileid' => '300', 'result' => 9],
            '400' => $this->publishedFile('400', ['consumer_app_id' => 440]),
            '500' => $this->publishedFile('500'),
        ]);

        $result = $this->importCollection();

        $this->assertSame(self::COLLECTION_ID, $result['collection_id']);
        $this->assertSame('PZIN', $result['name']);
        $this->assertSame(5, $result['total']);
        $this->assertSame(['200', '100'], array_column($result['items'], 'workshop_id'));
        $this->assertSame(['300', '400', '500'], $result['unavailable_ids']);
        Http::assertNotSent(fn ($request): bool => in_array('500', $request->data(), true));

        // Repeating the import must preserve the result and reuse the cache.
        $this->assertSame($result, $this->importCollection());
        Http::assertSentCount(3);
        Http::assertSent(fn ($request): bool => $request->url() === 'https://steam.test/ISteamRemoteStorage/GetCollectionDetails/v1/'
            && $request->method() === 'POST'
            && $request['collectioncount'] === 1
            && $request['publishedfileids[0]'] === self::COLLECTION_ID);
    }

    public function testCollectionWithOneHundredAndTenModsIsFetchedInBatchesWithoutLosingItems(): void
    {
        $children = [];
        $files = [];
        for ($index = 1; $index <= 110; ++$index) {
            $id = (string) $index;
            $children[] = ['publishedfileid' => $id, 'filetype' => 0];
            $files[$id] = $this->publishedFile($id);
        }
        $this->fakeSteam($children, $files);

        $result = $this->importCollection(self::COLLECTION_ID);

        $this->assertSame(110, $result['total']);
        $this->assertSame(array_column($children, 'publishedfileid'), array_column($result['items'], 'workshop_id'));
        $this->assertSame([], $result['unavailable_ids']);
        Http::assertSentCount(4);
    }

    public function testEmptyPublicCollectionIsAccepted(): void
    {
        $this->fakeSteam([]);

        $result = $this->importCollection();

        $this->assertSame(0, $result['total']);
        $this->assertSame([], $result['items']);
        $this->assertSame([], $result['unavailable_ids']);
        Http::assertSentCount(2);
    }

    #[DataProvider('invalidCollections')]
    public function testCollectionEndpointStillRejectsInvalidOrUnavailableCollections(array $payload, string $message): void
    {
        $this->fakeSteam([], collectionPayload: $payload);

        $this->expectException(DisplayException::class);
        $this->expectExceptionMessage($message);
        $this->importCollection();
    }

    public static function invalidCollections(): array
    {
        return [
            'ordinary mod is not a collection' => [
                ['response' => ['collectiondetails' => [['publishedfileid' => self::COLLECTION_ID, 'result' => 9]]]],
                'The Steam collection is unavailable, private or deleted.',
            ],
            'private collection' => [
                ['response' => ['collectiondetails' => [['publishedfileid' => self::COLLECTION_ID, 'result' => 15]]]],
                'The Steam collection is unavailable, private or deleted.',
            ],
            'mismatched collection id' => [
                ['response' => ['collectiondetails' => [['publishedfileid' => '999', 'result' => 1, 'children' => []]]]],
                'The Steam collection is unavailable, private or deleted.',
            ],
            'missing children is not an empty collection' => [
                ['response' => ['collectiondetails' => [['publishedfileid' => self::COLLECTION_ID, 'result' => 1]]]],
                'Steam did not return the collection items.',
            ],
            'malformed response' => [
                ['response' => ['collectiondetails' => 'invalid']],
                'Steam returned an invalid collection details response.',
            ],
        ];
    }

    public function testCollectionFromAnotherGameIsStillRejected(): void
    {
        $this->fakeSteam([], collectionMetadata: ['consumer_app_id' => 440]);

        $this->expectException(DisplayException::class);
        $this->expectExceptionMessage('Only Project Zomboid Workshop collections can be imported.');
        $this->importCollection();
    }

    public function testUnavailablePublishedFileIsStillRejected(): void
    {
        $this->fakeSteam([], collectionMetadata: ['result' => 9]);

        $this->expectException(DisplayException::class);
        $this->expectExceptionMessage('This Workshop link does not point to a public collection.');
        $this->importCollection();
    }

    public function testUntrustedUrlIsRejectedWithoutMakingARequest(): void
    {
        $this->expectException(DisplayException::class);
        $this->expectExceptionMessage('Paste a valid Steam Workshop collection URL or numeric ID.');

        try {
            $this->importCollection('https://example.com/sharedfiles/filedetails/?id=' . self::COLLECTION_ID);
        } finally {
            Http::assertNothingSent();
        }
    }

    private function publishedFile(string $id, array $overrides = []): array
    {
        return array_replace([
            'publishedfileid' => $id,
            'result' => 1,
            'title' => $id === self::COLLECTION_ID ? 'PZIN' : 'Mod ' . $id,
            'consumer_app_id' => 108600,
            'creator_app_id' => 108600,
            'visibility' => 0,
            'banned' => 0,
        ], $overrides);
    }

    private function fakeSteam(
        array $children,
        array $files = [],
        ?array $collectionPayload = null,
        array $collectionMetadata = [],
    ): void {
        $files[self::COLLECTION_ID] = $this->publishedFile(self::COLLECTION_ID, $collectionMetadata);
        Http::fake([
            'steam.test/ISteamRemoteStorage/GetPublishedFileDetails/v1/' => function ($request) use ($files) {
                $details = [];
                for ($index = 0; $index < $request['itemcount']; ++$index) {
                    $details[] = $files[$request["publishedfileids[$index]"]];
                }

                return Http::response(['response' => ['publishedfiledetails' => $details]]);
            },
            'steam.test/ISteamRemoteStorage/GetCollectionDetails/v1/' => Http::response($collectionPayload ?? [
                'response' => ['collectiondetails' => [[
                    'publishedfileid' => self::COLLECTION_ID,
                    'result' => 1,
                    'children' => $children,
                ]]],
            ]),
        ]);
    }

    private function importCollection(string $link = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' . self::COLLECTION_ID): array
    {
        $result = [];
        // The real credential store falls back to the configured test key when
        // integration queries return no rows. Pretend keeps these tests DB-free.
        DB::pretend(function () use ($link, &$result): void {
            $result = $this->service->collection($link);
        });

        return $result;
    }
}
