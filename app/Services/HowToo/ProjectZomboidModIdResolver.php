<?php

namespace Pterodactyl\Services\HowToo;

use Carbon\CarbonImmutable;
use Pterodactyl\Models\Server;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\Process\Process;
use Pterodactyl\Jobs\ResolveWorkshopModIds;
use Pterodactyl\Repositories\Wings\DaemonFileRepository;
use Illuminate\Contracts\Cache\Repository as CacheRepository;
use Pterodactyl\Exceptions\Http\Connection\DaemonConnectionException;

final class ProjectZomboidModIdResolver
{
    private const MAX_DEPTH = 5;
    private const MAX_ENTRIES_PER_ITEM = 500;
    private const MAX_MOD_INFO_SIZE = 256 * 1024;
    private const MAX_REMOTE_ARCHIVE_SIZE = 64 * 1024 * 1024;
    private const WORKSHOP_ROOTS = [
        '/.cache/Steam/steamapps/workshop/content/108600',
        '/.cache/steam/steamapps/workshop/content/108600',
        '/.steam/steamapps/workshop/content/108600',
        '/steamapps/workshop/content/108600',
        '/Steam/steamapps/workshop/content/108600',
        '/workshop/content/108600',
        '/steamcmd/steamapps/workshop/content/108600',
    ];

    public function __construct(
        private DaemonFileRepository $files,
        private CacheRepository $cache,
    ) {
    }

    /**
     * Resolve an item using its installed files or an inspection of the published files.
     * Descriptions are only a fallback when Steam does not expose the actual content.
     */
    public function resolveItem(array $item, array $installed = [], bool $queue = true): array
    {
        if ($installed !== []) {
            return ['mod_ids' => $installed, 'mod_id_source' => 'mod_info', 'mod_id_pending' => false];
        }

        $manifest = $this->manifestId($item);
        $url = $item['content_url'] ?? null;
        $hasArchive = is_string($url) && $this->trustedSteamContentUrl($url)
            && (int) ($item['content_size'] ?? 0) <= self::MAX_REMOTE_ARCHIVE_SIZE && class_exists(\ZipArchive::class);

        if (($manifest !== null && is_executable((string) config('howtoo.workshop.downloader'))) || $hasArchive) {
            $key = $this->publishedCacheKey($item);
            $result = $this->cache->get($key);
            if ($result === null && $queue) {
                if (Cache::add($key, ['state' => 'pending'], now()->addHours(2))) {
                    try {
                        ResolveWorkshopModIds::dispatch($key, $manifest, $hasArchive ? $url : null)->onQueue('workshop');
                    } catch (\Throwable $exception) {
                        Cache::forget($key);
                        throw $exception;
                    }
                }
                $result = $this->cache->get($key);
            }

            if (is_array($result)) {
                $ids = $result['ids'] ?? [];

                return [
                    'mod_ids' => $ids,
                    'mod_id_source' => $ids === [] ? null : 'remote_mod_info',
                    'mod_id_pending' => $result['state'] === 'pending',
                ];
            }
        }

        return $this->resolveSteamItem($item) + ['mod_id_pending' => false];
    }

    public function resolveSteamItem(array $item): array
    {
        $metadata = $this->fromSteamMetadata($item);
        $description = $this->fromDescription((string) ($item['raw_description'] ?? $item['description'] ?? ''));

        return [
            'mod_ids' => $this->normalize(array_merge($metadata, $description)),
            'mod_id_source' => $metadata !== [] ? 'steam_metadata' : ($description === [] ? null : 'workshop_description'),
        ];
    }

    public function inspectPublishedFiles(?string $manifest, ?string $url): array
    {
        $ids = $manifest === null ? [] : $this->fromWorkshopManifest($manifest);

        return $ids === [] && $url !== null ? $this->fromRemoteArchive($url) : $ids;
    }

    private function manifestId(array $item): ?string
    {
        $id = (string) ($item['content_manifest'] ?? '');

        return preg_match('/^[1-9][0-9]{0,19}$/D', $id) === 1 ? $id : null;
    }

    private function publishedCacheKey(array $item): string
    {
        $version = $this->manifestId($item) ?? ($item['updated_at'] ?? $item['content_url']);

        return 'howtoo:pz-published-mod-ids:' . $item['workshop_id'] . ':' . sha1((string) $version);
    }

    private function fromWorkshopManifest(string $manifest): array
    {
        $downloader = (string) config('howtoo.workshop.downloader');
        if (!is_executable($downloader) || preg_match('/^[1-9][0-9]{0,19}$/D', $manifest) !== 1) {
            return [];
        }

        $directory = sys_get_temp_dir() . '/howtoo-pz-' . bin2hex(random_bytes(16));
        if (!mkdir($directory, 0700)) {
            return [];
        }

        try {
            $process = new Process([$downloader, $manifest, $directory], $directory);
            $process->setTimeout(45);
            $process->disableOutput();
            if ($process->run() !== 0) {
                return [];
            }

            $ids = [];
            foreach (File::allFiles($directory, true) as $file) {
                if (!$file->isLink() && strcasecmp($file->getFilename(), 'mod.info') === 0
                    && $file->getSize() <= self::MAX_MOD_INFO_SIZE) {
                    $ids = array_merge($ids, $this->parseModInfo($file->getContents()));
                }
            }

            return $this->normalize($ids);
        } catch (\Symfony\Component\Process\Exception\RuntimeException) {
            return [];
        } finally {
            File::deleteDirectory($directory);
        }
    }

    /** @return array<string, string[]> */
    public function resolveInstalled(Server $server, array $workshopIds): array
    {
        $ids = collect($workshopIds)
            ->map(fn ($id): string => trim((string) $id))
            ->filter(fn (string $id): bool => preg_match('/^\d{1,20}$/', $id) === 1)
            ->unique()
            ->take(500)
            ->values();
        $resolved = [];
        $pending = [];

        foreach ($ids as $id) {
            $cached = $this->cache->get($this->cacheKey($server, $id));
            if (is_array($cached) && $cached !== []) {
                $resolved[$id] = $cached;
            } else {
                $pending[] = $id;
            }
        }

        if ($pending === []) {
            return $resolved;
        }

        $repository = $this->files->setServer($server);
        foreach (self::WORKSHOP_ROOTS as $root) {
            try {
                $entries = $repository->getDirectory($root);
            } catch (DaemonConnectionException) {
                continue;
            }

            $available = collect($entries)
                ->filter(fn (array $entry): bool => !($entry['file'] ?? true) && !($entry['symlink'] ?? false))
                ->map(fn (array $entry): string => (string) ($entry['name'] ?? ''))
                ->filter(fn (string $name): bool => in_array($name, $pending, true))
                ->values();

            foreach ($available as $id) {
                $modIds = $this->scanWorkshopItem($repository, "$root/$id");
                if ($modIds !== []) {
                    $resolved[$id] = $modIds;
                    $this->cache->put($this->cacheKey($server, $id), $modIds, CarbonImmutable::now()->addMinutes(5));
                    $pending = array_values(array_diff($pending, [$id]));
                }
            }

            if ($pending === []) {
                break;
            }
        }

        return $resolved;
    }

    public function fromSteamMetadata(array $item): array
    {
        $values = [];
        $metadata = $item['metadata'] ?? null;
        if (is_string($metadata) && $metadata !== '') {
            $decoded = json_decode($metadata, true);
            if (is_array($decoded)) {
                $values = $this->metadataValues($decoded);
            } else {
                $values = $this->fromDescription($metadata);
            }
        }

        foreach (($item['kv_tags'] ?? []) as $tag) {
            if (is_array($tag) && $this->isModIdKey((string) ($tag['key'] ?? ''))) {
                $values[] = (string) ($tag['value'] ?? '');
            }
        }

        return $this->normalize($this->splitLists($values));
    }

    private function metadataValues(array $metadata): array
    {
        $values = [];
        foreach ($metadata as $key => $value) {
            if ($this->isModIdKey((string) $key)) {
                foreach ((array) $value as $id) {
                    if (is_string($id) || is_int($id)) {
                        $values[] = (string) $id;
                    }
                }
            } elseif (is_array($value)) {
                $values = array_merge($values, $this->metadataValues($value));
            }
        }

        return $values;
    }

    private function isModIdKey(string $key): bool
    {
        return preg_match('/^(?:mod[ _-]?)?ids?$/iD', $key) === 1;
    }

    public function fromDescription(string $description): array
    {
        $text = preg_replace('/<br\s*\/?\s*>|<\/(?:div|p|li)>/i', "\n", $description) ?? '';
        $text = html_entity_decode(strip_tags($text), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = preg_replace('/\[\/?(?:b|i|u|code|noparse|h[1-6]|url|list|quote|color)(?:=[^\]\r\n]*)?\]/i', '', $text) ?? '';
        preg_match_all('/\bMod[ _-]*IDs?\s*[:=][ \t]*([^\r\n]+)/iu', $text, $matches);
        $values = preg_replace('~\s*/\s*Workshop ID:.*$~i', '', $matches[1]);

        return $this->normalize($this->splitLists($values));
    }

    public function parseModInfo(string $content): array
    {
        $content = preg_replace('/^\xEF\xBB\xBF/', '', $content) ?? $content;
        preg_match_all('/^[ \t]*id[ \t]*=[ \t]*([^\r\n;]+)\r?$/im', $content, $matches);

        return $this->normalize($matches[1]);
    }

    private function fromRemoteArchive(string $url): array
    {
        if (!$this->trustedSteamContentUrl($url) || !class_exists(\ZipArchive::class)) {
            return [];
        }

        $temporary = tempnam(storage_path('framework/cache'), 'howtoo-pz-');
        if (!is_string($temporary)) {
            return [];
        }

        try {
            $response = Http::accept('*/*')
                ->connectTimeout(5)
                ->timeout(35)
                ->withOptions([
                    'sink' => $temporary,
                    'allow_redirects' => false,
                    'on_headers' => function ($response): void {
                        $length = (int) $response->getHeaderLine('Content-Length');
                        if ($length > self::MAX_REMOTE_ARCHIVE_SIZE) {
                            throw new \RuntimeException('Steam Workshop archive exceeds the metadata limit.');
                        }
                    },
                    'progress' => function ($downloadTotal, $downloadedBytes): void {
                        if ($downloadedBytes > self::MAX_REMOTE_ARCHIVE_SIZE) {
                            throw new \RuntimeException('Steam Workshop archive exceeded the download limit.');
                        }
                    },
                ])
                ->get($url);

            clearstatcache(true, $temporary);
            if (!$response->successful() || filesize($temporary) > self::MAX_REMOTE_ARCHIVE_SIZE) {
                return [];
            }

            $archive = new \ZipArchive();
            if ($archive->open($temporary) !== true) {
                return [];
            }

            try {
                $modIds = [];
                $files = min($archive->numFiles, 5000);
                for ($index = 0; $index < $files; ++$index) {
                    $stat = $archive->statIndex($index);
                    $path = str_replace('\\', '/', (string) ($stat['name'] ?? ''));
                    if (strcasecmp(basename($path), 'mod.info') !== 0 || str_contains($path, '../')) {
                        continue;
                    }
                    if ((int) ($stat['size'] ?? 0) > self::MAX_MOD_INFO_SIZE) {
                        continue;
                    }

                    $content = $archive->getFromIndex($index, self::MAX_MOD_INFO_SIZE);
                    if (is_string($content)) {
                        $modIds = array_merge($modIds, $this->parseModInfo($content));
                    }
                }

                return $this->normalize($modIds);
            } finally {
                $archive->close();
            }
        } catch (\Throwable) {
            return [];
        } finally {
            @unlink($temporary);
        }
    }

    private function scanWorkshopItem(DaemonFileRepository $repository, string $root): array
    {
        $queue = [[$root, 0]];
        $visited = 0;
        $modIds = [];

        while ($queue !== [] && $visited < self::MAX_ENTRIES_PER_ITEM) {
            [$directory, $depth] = array_shift($queue);

            try {
                $entries = $repository->getDirectory($directory);
            } catch (DaemonConnectionException) {
                continue;
            }

            foreach ($entries as $entry) {
                if (++$visited > self::MAX_ENTRIES_PER_ITEM || ($entry['symlink'] ?? false)) {
                    continue;
                }

                $name = (string) ($entry['name'] ?? '');
                if ($name === '' || basename($name) !== $name || in_array($name, ['.', '..'], true)) {
                    continue;
                }

                $path = "$directory/$name";
                if (!($entry['file'] ?? true)) {
                    if ($depth < self::MAX_DEPTH && strcasecmp($name, 'media') !== 0) {
                        $queue[] = [$path, $depth + 1];
                    }
                    continue;
                }

                if (strcasecmp($name, 'mod.info') !== 0) {
                    continue;
                }

                try {
                    $modIds = array_merge($modIds, $this->parseModInfo(
                        $repository->getContent($path, self::MAX_MOD_INFO_SIZE),
                    ));
                } catch (\Throwable) {
                    // A broken mod.info must not prevent other mods in the item from being resolved.
                }
            }
        }

        return $this->normalize($modIds);
    }

    private function normalize(array $values): array
    {
        return collect($values)
            ->map(fn (string $value): string => ltrim(trim($value), '\\'))
            ->filter(fn (string $value): bool => preg_match(ZomboidWorkshopConfigService::MOD_ID_PATTERN, $value) === 1)
            ->unique()
            ->values()
            ->all();
    }

    private function splitLists(array $values): array
    {
        return collect($values)->flatMap(fn (string $value): array => preg_split('/[;,]/', $value) ?: [])->all();
    }

    private function cacheKey(Server $server, string $workshopId): string
    {
        return "howtoo:pz-mod-ids:{$server->uuid}:$workshopId";
    }

    private function trustedSteamContentUrl(string $url): bool
    {
        $parts = parse_url($url);
        if (!is_array($parts) || ($parts['scheme'] ?? null) !== 'https' || !is_string($parts['host'] ?? null)) {
            return false;
        }

        $host = mb_strtolower($parts['host']);

        return $host === 'steamusercontent.com'
            || str_ends_with($host, '.steamusercontent.com')
            || $host === 'steamcontent.com'
            || str_ends_with($host, '.steamcontent.com')
            || $host === 'steamusercontent-a.akamaihd.net';
    }
}
