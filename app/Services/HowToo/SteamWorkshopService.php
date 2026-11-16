<?php

namespace Pterodactyl\Services\HowToo;

use Illuminate\Support\Str;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Cache;
use Pterodactyl\Exceptions\DisplayException;
use Illuminate\Http\Client\ConnectionException;

final class SteamWorkshopService
{
    private const PROJECT_ZOMBOID_APP_ID = 108600;
    private const QUERY_TYPE_TRENDING = 3;
    private const QUERY_TYPE_MOST_SUBSCRIBED = 9;
    private const QUERY_TYPE_TEXT_SEARCH = 12;
    private const QUERY_TYPE_RECENTLY_UPDATED = 21;
    private const DEFAULT_PER_PAGE = 30;
    private const MAX_PER_PAGE = 50;
    private const MAX_COLLECTION_ITEMS = 500;
    private const COLLECTION_DETAILS_BATCH = 100;
    private const BROWSE_MODES = ['search', 'trending', 'most_subscribed', 'recent'];

    public function __construct(
        private IntegrationCredentialStore $credentials,
        private ProjectZomboidModIdResolver $modIds,
    ) {
    }

    public function search(
        string $query,
        int $page = 1,
        int $perPage = self::DEFAULT_PER_PAGE,
        array $tags = [],
    ): array {
        $query = trim($query);
        $page = max(1, $page);
        $perPage = max(10, min($perPage, self::MAX_PER_PAGE));
        $tags = $this->normalizeTags($tags);

        if ($workshopId = $this->directWorkshopId($query)) {
            $item = $this->details([$workshopId])[0] ?? null;
            if (!$item || $item['workshop_id'] !== $workshopId) {
                throw new DisplayException('The Steam Workshop item was not found or is private/deleted.');
            }

            return $this->result([$item], 1, 1, $perPage, true);
        }

        if ($this->looksLikeUrl($query)) {
            throw new DisplayException('The Steam Workshop URL is invalid.');
        }

        $response = $this->queryWorkshop(
            'search:' . sha1($query),
            self::QUERY_TYPE_TEXT_SEARCH,
            $query,
            $page,
            $perPage,
            $tags,
        );
        $items = $this->itemsFromResponse($response);
        $total = max(0, (int) data_get($response, 'response.total', count($items)));

        return $this->result($this->rankResults($items, $query), $total, $page, $perPage, false);
    }

    public function browse(
        string $mode = 'trending',
        int $page = 1,
        int $perPage = self::DEFAULT_PER_PAGE,
        array $tags = [],
    ): array {
        $mode = in_array($mode, self::BROWSE_MODES, true) && $mode !== 'search' ? $mode : 'trending';
        $page = max(1, $page);
        $perPage = max(10, min($perPage, self::MAX_PER_PAGE));
        $tags = $this->normalizeTags($tags);
        $queryType = match ($mode) {
            'most_subscribed' => self::QUERY_TYPE_MOST_SUBSCRIBED,
            'recent' => self::QUERY_TYPE_RECENTLY_UPDATED,
            default => self::QUERY_TYPE_TRENDING,
        };

        $response = $this->queryWorkshop($mode, $queryType, '', $page, $perPage, $tags);
        $items = $this->itemsFromResponse($response);
        $total = max(0, (int) data_get($response, 'response.total', count($items)));

        return $this->result($items, $total, $page, $perPage, false);
    }

    public function details(array $workshopIds): array
    {
        $this->requireCredential();
        $items = [];
        foreach (array_chunk($this->workshopIds($workshopIds), self::COLLECTION_DETAILS_BATCH) as $ids) {
            array_push($items, ...$this->detailsBatch($ids));
        }

        return $items;
    }

    private function detailsBatch(array $ids): array
    {

        $cacheKey = 'howtoo:steam:details:v2:' . sha1(implode(',', $ids));

        return Cache::remember($cacheKey, now()->addMinutes(10), function () use ($ids): array {
            $payload = ['itemcount' => count($ids)];
            foreach ($ids as $index => $id) {
                $payload["publishedfileids[$index]"] = $id;
            }

            try {
                $response = Http::baseUrl(config('howtoo.providers.steam.base_url'))
                    ->acceptJson()
                    ->asForm()
                    ->connectTimeout(5)
                    ->timeout(20)
                    ->post('/ISteamRemoteStorage/GetPublishedFileDetails/v1/', $payload);
            } catch (ConnectionException) {
                throw new DisplayException('Steam Workshop details are temporarily unavailable.');
            }

            $this->throwForSteamResponse($response->status());
            $items = data_get($response->json(), 'response.publishedfiledetails', []);
            if (!is_array($items)) {
                throw new DisplayException('Steam Workshop returned an invalid details response.');
            }

            return collect($items)
                ->filter(fn ($item): bool => is_array($item) && (int) ($item['result'] ?? 1) === 1)
                ->map(fn (array $item): array => $this->transform($item))
                ->filter(fn (array $item): bool => $item['workshop_id'] !== '')
                ->values()
                ->all();
        });
    }

    /**
     * Import a public Project Zomboid collection from Steam.
     * Nothing here changes the server INI; the UI must explicitly save it.
     */
    public function collection(string $link): array
    {
        $this->requireCredential();
        $collectionId = $this->directWorkshopId(trim($link));
        if ($collectionId === null) {
            throw new DisplayException('Paste a valid Steam Workshop collection URL or numeric ID.');
        }

        $collection = $this->details([$collectionId])[0] ?? null;
        if (!$collection || $collection['workshop_id'] !== $collectionId) {
            throw new DisplayException('This Workshop link does not point to a public collection.');
        }
        if ($collection['consumer_app_id'] !== self::PROJECT_ZOMBOID_APP_ID) {
            throw new DisplayException('Only Project Zomboid Workshop collections can be imported.');
        }

        $cacheKey = 'howtoo:steam:collection:v3:' . $collectionId;

        return Cache::remember($cacheKey, now()->addMinutes(5), function () use ($collectionId, $collection): array {
            try {
                $response = Http::baseUrl(config('howtoo.providers.steam.base_url'))
                    ->acceptJson()
                    ->asForm()
                    ->connectTimeout(5)
                    ->timeout(20)
                    ->post('/ISteamRemoteStorage/GetCollectionDetails/v1/', [
                        'collectioncount' => 1,
                        'publishedfileids[0]' => $collectionId,
                    ]);
            } catch (ConnectionException) {
                throw new DisplayException('The Steam Workshop collection is temporarily unavailable.');
            }

            $this->throwForSteamResponse($response->status());
            $payload = $response->json();
            if (!is_array($payload)) {
                throw new DisplayException('Steam returned an invalid collection response.');
            }
            // GetPublishedFileDetails omits file_type. A successful collection
            // response, not that optional metadata field, confirms the type.
            $children = $this->collectionChildren($payload, $collectionId);
            $ids = array_column($children, 'workshop_id');
            $modIds = array_column(array_filter(
                $children,
                fn (array $child): bool => $child['file_type'] !== 2,
            ), 'workshop_id');
            $resolved = [];
            foreach ($this->details($modIds) as $item) {
                if ($this->isProjectZomboidItem($item)) {
                    $resolved[$item['workshop_id']] = $item;
                }
            }

            $items = [];
            $unavailable = [];
            foreach ($ids as $id) {
                if (!isset($resolved[$id])) {
                    $unavailable[] = $id;
                    continue;
                }
                $items[] = $resolved[$id];
            }

            return [
                'collection_id' => $collectionId,
                'name' => $collection['name'],
                'total' => count($ids),
                'items' => $items,
                'unavailable_ids' => $unavailable,
            ];
        });
    }

    public function isProjectZomboidItem(array $item): bool
    {
        return $item['consumer_app_id'] === self::PROJECT_ZOMBOID_APP_ID && $item['file_type'] !== 2;
    }

    /** @return array<int, array{workshop_id: string, file_type: int}> */
    private function collectionChildren(array $payload, string $collectionId): array
    {
        $records = data_get($payload, 'response.collectiondetails');
        if (!is_array($records)) {
            throw new DisplayException('Steam returned an invalid collection details response.');
        }
        $collection = collect($records)->first(
            fn ($record): bool => is_array($record) && (string) ($record['publishedfileid'] ?? '') === $collectionId
        );
        if (!is_array($collection) || (int) ($collection['result'] ?? 0) !== 1) {
            throw new DisplayException('The Steam collection is unavailable, private or deleted.');
        }
        $children = $collection['children'] ?? null;
        if (!is_array($children)) {
            throw new DisplayException('Steam did not return the collection items.');
        }
        if (count($children) > self::MAX_COLLECTION_ITEMS) {
            throw new DisplayException('This collection contains more than 500 items and cannot be imported in one request.');
        }

        return collect($children)
            ->filter(fn ($child): bool => is_array($child)
                && preg_match('/^\d{1,20}$/', (string) ($child['publishedfileid'] ?? '')) === 1)
            ->map(fn (array $child): array => [
                'workshop_id' => (string) $child['publishedfileid'],
                // This endpoint supplies filetype, unlike published file details.
                'file_type' => (int) ($child['filetype'] ?? 0),
            ])
            ->unique('workshop_id')
            ->values()
            ->all();
    }

    private function requireCredential(): string
    {
        $key = $this->credentials->secret('steam');
        if (!$this->credentials->isEnabled('steam') || !$key) {
            throw new DisplayException('Steam Workshop is not configured by the administrator.');
        }

        return $key;
    }

    private function transform(array $item): array
    {
        $description = $this->plainText((string) ($item['description'] ?? $item['short_description'] ?? ''));

        $tags = collect($item['tags'] ?? [])
            ->map(fn ($tag): string => is_array($tag) ? trim((string) ($tag['tag'] ?? '')) : trim((string) $tag))
            ->filter()
            ->unique()
            ->values()
            ->all();
        $voteData = is_array($item['vote_data'] ?? null) ? $item['vote_data'] : [];

        return $this->modIds->resolveSteamItem($item) + [
            'workshop_id' => (string) ($item['publishedfileid'] ?? ''),
            // Internal-only Steam fields used to reject other games/collections.
            'file_type' => (int) ($item['file_type'] ?? 0),
            'consumer_app_id' => (int) ($item['consumer_app_id'] ?? $item['creator_app_id'] ?? 0),
            'name' => mb_substr(trim((string) ($item['title'] ?? 'Untitled mod')), 0, 180),
            'image' => filter_var($item['preview_url'] ?? null, FILTER_VALIDATE_URL) ?: null,
            'description' => mb_substr($description, 0, 12000),
            'tags' => $tags,
            'score' => isset($voteData['score']) ? (float) $voteData['score'] : null,
            'votes_up' => isset($voteData['votes_up']) ? (int) $voteData['votes_up'] : null,
            'votes_down' => isset($voteData['votes_down']) ? (int) $voteData['votes_down'] : null,
            'subscriptions' => isset($item['subscriptions']) ? (int) $item['subscriptions'] : null,
            'creator_id' => isset($item['creator']) ? (string) $item['creator'] : null,
            'metadata' => $item['metadata'] ?? null,
            'kv_tags' => $item['kv_tags'] ?? [],
            'raw_description' => (string) ($item['description'] ?? ''),
            'content_manifest' => (string) ($item['hcontent_file'] ?? ''),
            'content_url' => filter_var($item['file_url'] ?? null, FILTER_VALIDATE_URL) ?: null,
            'content_size' => isset($item['file_size']) ? (int) $item['file_size'] : null,
            'updated_at' => isset($item['time_updated']) ? (int) $item['time_updated'] : null,
        ];
    }

    private function plainText(string $value): string
    {
        $value = strip_tags($value);
        $value = preg_replace('/\[(?:\/?)[A-Za-z][^\]]*\]/', '', $value) ?? '';
        $value = html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8');

        return trim(preg_replace('/\s+/u', ' ', $value) ?? '');
    }

    private function workshopIds(array $ids): array
    {
        return collect($ids)
            ->map(fn ($id): string => trim((string) $id))
            ->filter(fn (string $id): bool => preg_match('/^\d{1,20}$/', $id) === 1)
            ->unique()
            ->take(self::MAX_COLLECTION_ITEMS)
            ->values()
            ->all();
    }

    private function queryWorkshop(
        string $cacheFragment,
        int $queryType,
        string $query,
        int $page,
        int $perPage,
        array $tags,
    ): array {
        $key = $this->requireCredential();
        $cacheKey = sprintf(
            'howtoo:steam:query:%s:%d:%d:%s',
            $cacheFragment,
            $page,
            $perPage,
            sha1(implode('|', $tags)),
        );

        return Cache::remember($cacheKey, now()->addMinutes(2), function () use ($key, $queryType, $query, $page, $perPage, $tags): array {
            try {
                $response = Http::baseUrl(config('howtoo.providers.steam.base_url'))
                    ->acceptJson()
                    ->connectTimeout(5)
                    ->timeout(20)
                    ->get('/IPublishedFileService/QueryFiles/v1/', $this->queryParameters(
                        $key,
                        $queryType,
                        $query,
                        $page,
                        $perPage,
                        $tags,
                    ));
            } catch (ConnectionException) {
                throw new DisplayException('Steam Workshop is temporarily unavailable.');
            }

            $this->throwForSteamResponse($response->status());
            $payload = $response->json();
            if (!is_array($payload)) {
                throw new DisplayException('Steam Workshop returned an invalid response.');
            }

            return $payload;
        });
    }

    private function itemsFromResponse(array $response): array
    {
        $publishedFiles = data_get($response, 'response.publishedfiledetails', []);
        $publishedFiles = is_array($publishedFiles) ? $publishedFiles : [];

        return collect($publishedFiles)
            ->filter(fn ($item): bool => is_array($item))
            ->map(fn (array $item): array => $this->transform($item))
            ->filter(fn (array $item): bool => $item['workshop_id'] !== '')
            ->unique('workshop_id')
            ->values()
            ->all();
    }

    private function normalizeTags(array $tags): array
    {
        $allowed = [
            'Build 42', 'Build 41', 'Animals', 'Audio', 'Balance', 'Building', 'Clothing/Armor',
            'Farming', 'Food', 'Framework', 'Hardmode', 'Interface', 'Items', 'Language/Translation',
            'Literature', 'Map',
        ];

        return collect($tags)
            ->map(fn ($tag): string => trim((string) $tag))
            ->filter(fn (string $tag): bool => in_array($tag, $allowed, true))
            ->unique()
            ->take(8)
            ->values()
            ->all();
    }

    private function queryParameters(
        string $key,
        int $queryType,
        string $query,
        int $page,
        int $perPage,
        array $tags = [],
    ): array {
        $parameters = [
            'key' => $key,
            'query_type' => $queryType,
            'page' => $page,
            'numperpage' => $perPage,
            'creator_appid' => self::PROJECT_ZOMBOID_APP_ID,
            'appid' => self::PROJECT_ZOMBOID_APP_ID,
            'search_text' => $query,
            'cache_max_age_seconds' => 120,
            'return_details' => true,
            'return_metadata' => true,
            'return_kv_tags' => true,
            'return_tags' => true,
            'return_previews' => true,
            'return_vote_data' => true,
        ];

        if ($queryType === self::QUERY_TYPE_TRENDING) {
            $parameters['days'] = 7;
            $parameters['include_recent_votes_only'] = true;
        }

        if ($tags !== []) {
            // QueryFiles documents requiredtags as a comma-delimited string.
            $parameters['requiredtags'] = implode(',', $tags);
            $parameters['match_all_tags'] = true;
        }

        return $parameters;
    }

    private function result(array $items, int $total, int $page, int $perPage, bool $direct): array
    {
        $totalPages = $total === 0 ? 0 : (int) ceil($total / $perPage);

        return [
            'items' => $items,
            'pagination' => [
                'page' => $page,
                'per_page' => $perPage,
                'total' => $total,
                'total_pages' => $totalPages,
                'has_next' => !$direct && $page < $totalPages,
            ],
            'mode' => $direct ? 'direct' : 'text',
        ];
    }

    private function directWorkshopId(string $query): ?string
    {
        if (preg_match('/^\d{1,20}$/', $query) === 1) {
            return $query;
        }

        if (!$this->looksLikeUrl($query)) {
            return null;
        }

        $parts = parse_url($query);
        $host = strtolower((string) ($parts['host'] ?? ''));
        $path = rtrim((string) ($parts['path'] ?? ''), '/');
        if (!in_array($host, ['steamcommunity.com', 'www.steamcommunity.com'], true)
            || $path !== '/sharedfiles/filedetails') {
            return null;
        }

        parse_str((string) ($parts['query'] ?? ''), $parameters);
        $id = trim((string) ($parameters['id'] ?? ''));

        return preg_match('/^\d{1,20}$/', $id) === 1 ? $id : null;
    }

    private function looksLikeUrl(string $query): bool
    {
        return preg_match('#^https?://#i', $query) === 1;
    }

    private function rankResults(array $items, string $query): array
    {
        $needle = $this->searchableText($query);
        $tokens = array_values(array_filter(explode(' ', $needle)));

        return collect($items)
            ->values()
            ->map(function (array $item, int $position) use ($needle, $tokens): array {
                $title = $this->searchableText((string) ($item['name'] ?? ''));
                $description = $this->searchableText((string) ($item['description'] ?? ''));
                $haystack = trim("$title $description");
                $rank = match (true) {
                    $title === $needle => 0,
                    $needle !== '' && str_starts_with($title, $needle) => 100,
                    $needle !== '' && str_contains($title, $needle) => 200,
                    $tokens !== [] && collect($tokens)->every(fn (string $token): bool => str_contains($title, $token)) => 300,
                    $needle !== '' && str_contains($description, $needle) => 400,
                    $tokens !== [] && collect($tokens)->every(fn (string $token): bool => str_contains($haystack, $token)) => 500,
                    default => 1000,
                };

                return ['item' => $item, 'rank' => $rank, 'position' => $position];
            })
            ->sortBy([['rank', 'asc'], ['position', 'asc']])
            ->pluck('item')
            ->values()
            ->all();
    }

    private function searchableText(string $value): string
    {
        $value = mb_strtolower(Str::ascii(trim($value)));
        $value = preg_replace('/[^a-z0-9]+/', ' ', $value) ?? '';

        return trim(preg_replace('/\s+/', ' ', $value) ?? '');
    }

    private function throwForSteamResponse(int $status): void
    {
        if ($status >= 200 && $status < 300) {
            return;
        }

        throw new DisplayException(match ($status) {
            401, 403 => 'Steam Workshop authentication failed. Contact an administrator.', 404 => 'The Steam Workshop endpoint or item was not found.', 429 => 'Steam Workshop rate limit reached. Please try again shortly.', default => 'Steam Workshop is temporarily unavailable.',
        });
    }
}
