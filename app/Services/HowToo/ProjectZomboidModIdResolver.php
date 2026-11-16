<?php

namespace Pterodactyl\Services\HowToo;

use Carbon\CarbonImmutable;
use Pterodactyl\Models\Server;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\Process\Process;
use Pterodactyl\Jobs\ResolveWorkshopModIds;
use Pterodactyl\Repositories\Wings\DaemonFileRepository;
use Illuminate\Contracts\Cache\Repository as CacheRepository;
use Pterodactyl\Exceptions\Http\Connection\DaemonConnectionException;

/**
 * Finds the Project Zomboid Mod IDs ("id=" in mod.info) published by a Workshop item.
 *
 * Sources, from most to least authoritative:
 *  1. mod_info         - mod.info files already downloaded on the game server (via Wings).
 *  2. remote_mod_info  - mod.info files fetched from Steam (DepotDownloader / legacy file_url zip).
 *  3. steam_metadata   - structured metadata/kvtags on the Workshop item (rarely used by PZ mods).
 *  4. workshop_description - "Mod ID: X" lines in the Workshop description.
 *
 * A weaker source never hides a stronger one, and a failing stronger source never
 * erases what a weaker one found. Remote inspection only runs when the Steam data
 * alone does not expose any Mod ID.
 */
final class ProjectZomboidModIdResolver
{
    public const REASON_DOWNLOADER_UNAVAILABLE = 'downloader_unavailable';
    public const REASON_INSPECTION_FAILED = 'inspection_failed';
    public const REASON_QUEUE_STALLED = 'queue_stalled';
    public const REASON_NO_PUBLISHED_FILES = 'no_published_files';

    private const MAX_DEPTH = 5;
    private const MAX_ENTRIES_PER_ITEM = 500;
    private const MAX_MOD_INFO_SIZE = 256 * 1024;
    private const MAX_REMOTE_ARCHIVE_SIZE = 64 * 1024 * 1024;
    private const MAX_DESCRIPTION_FOLLOW_LINES = 10;
    private const MAX_DESCRIPTION_ID_WORDS = 8;
    private const DOWNLOADER_TIMEOUT_SECONDS = 60;
    /** A job that never started within this window means no worker is consuming the queue. */
    private const QUEUED_STALE_SECONDS = 600;
    /** A job that started but never finished within this window crashed or was killed. */
    private const RUNNING_STALE_SECONDS = 180;
    private const PENDING_TTL_MINUTES = 20;
    private const INSTALLED_CACHE_MINUTES = 30;
    private const INSTALLED_MISS_CACHE_MINUTES = 2;
    private const WORKSHOP_ROOTS = [
        '/.cache/Steam/steamapps/workshop/content/108600',
        '/.cache/steam/steamapps/workshop/content/108600',
        '/.steam/steamapps/workshop/content/108600',
        '/steamapps/workshop/content/108600',
        '/Steam/steamapps/workshop/content/108600',
        '/workshop/content/108600',
        '/steamcmd/steamapps/workshop/content/108600',
    ];
    /** Steam BBCode that separates blocks of text. */
    private const BLOCK_BBCODE = 'h[1-6]|hr|list|olist|\*|quote|code|table|tr|th|td|p|spoiler';
    /** Steam BBCode that only formats inline text. */
    private const INLINE_BBCODE = 'b|i|u|s|strike|noparse|url|img|color|size|previewyoutube|emoticon';
    private const LABEL = 'Mod[ _-]*IDs?';
    /** Optional qualifier between the label and the colon: "(B42)", "[Build 41]", "for B42", "'s". */
    private const LABEL_QUALIFIER = "(?:'s)?\\s*(?:\\([^()\\r\\n]{0,30}\\)|\\[[^\\[\\]\\r\\n]{0,30}\\]|(?:for\\s+)?(?:b|build)\\s*\\d[\\w.]*)?\\s*";
    private const PLACEHOLDERS = ['none', 'n/a', 'na', 'tbd', 'same', 'see below', 'below', 'above', '-', '?'];

    public function __construct(
        private DaemonFileRepository $files,
        private CacheRepository $cache,
    ) {
    }

    /**
     * Resolve the Mod IDs of a transformed Steam item.
     *
     * @return array{mod_ids: string[], mod_id_source: ?string, mod_id_pending: bool, mod_id_reason: ?string}
     */
    public function resolveItem(array $item, array $installed = [], bool $queue = true): array
    {
        $installed = $this->normalize($installed);
        if ($installed !== []) {
            return $this->result($installed, 'mod_info');
        }

        $remote = $this->remoteState($item);
        if (($remote['state'] ?? null) === 'complete' && ($remote['ids'] ?? []) !== []) {
            return $this->result($remote['ids'], 'remote_mod_info');
        }

        $steam = $this->resolveSteamItem($item);
        if ($steam['mod_ids'] !== []) {
            return $this->result($steam['mod_ids'], $steam['mod_id_source']);
        }

        if (!$this->canInspectRemotely($item)) {
            return $this->result([], null, reason: $this->manifestId($item) !== null
                ? self::REASON_DOWNLOADER_UNAVAILABLE
                : self::REASON_NO_PUBLISHED_FILES);
        }

        if ($remote === null && $queue) {
            $remote = $this->queueInspection($item);
        }

        return match ($remote['state'] ?? null) {
            'queued', 'running' => $this->isStale($remote)
                ? $this->result([], null, reason: self::REASON_QUEUE_STALLED)
                : $this->result([], null, pending: true),
            'unavailable', 'complete' => $this->result([], null, reason: self::REASON_INSPECTION_FAILED),
            default => $this->result([], null),
        };
    }

    /** @return array{mod_ids: string[], mod_id_source: ?string} */
    public function resolveSteamItem(array $item): array
    {
        $metadata = $this->fromSteamMetadata($item);
        $description = $this->fromDescription((string) ($item['raw_description'] ?? $item['description'] ?? ''));

        return [
            'mod_ids' => $this->normalize(array_merge($metadata, $description)),
            'mod_id_source' => $metadata !== [] ? 'steam_metadata' : ($description === [] ? null : 'workshop_description'),
        ];
    }

    /**
     * Download only the mod.info files of the published item and read their ids.
     *
     * @return array{ids: string[], error: ?string}
     */
    public function inspectPublishedFiles(?string $manifest, ?string $url): array
    {
        $errors = [];
        if ($manifest !== null) {
            $result = $this->fromWorkshopManifest($manifest);
            if ($result['ids'] !== []) {
                return $result;
            }
            $errors[] = $result['error'];
        }

        if ($url !== null) {
            $result = $this->fromRemoteArchive($url);
            if ($result['ids'] !== []) {
                return $result;
            }
            $errors[] = $result['error'];
        }

        $errors = array_values(array_filter($errors));

        return ['ids' => [], 'error' => $errors === [] ? 'No downloadable content was published for this item.' : implode(' | ', $errors)];
    }

    /** Whether published files can be inspected for this item on this installation. */
    public function canInspectRemotely(array $item): bool
    {
        return ($this->manifestId($item) !== null && $this->downloaderAvailable()) || $this->archiveUrl($item) !== null;
    }

    public function downloaderAvailable(): bool
    {
        $downloader = (string) config('howtoo.workshop.downloader');

        return $downloader !== '' && is_file($downloader) && is_executable($downloader);
    }

    public function manifestId(array $item): ?string
    {
        $id = (string) ($item['content_manifest'] ?? '');

        return preg_match('/^[1-9][0-9]{0,19}$/D', $id) === 1 ? $id : null;
    }

    public function archiveUrl(array $item): ?string
    {
        $url = $item['content_url'] ?? null;

        return is_string($url) && $url !== '' && $this->trustedSteamContentUrl($url)
            && (int) ($item['content_size'] ?? 0) <= self::MAX_REMOTE_ARCHIVE_SIZE
            && class_exists(\ZipArchive::class) ? $url : null;
    }

    public function publishedCacheKey(array $item): string
    {
        $version = $this->manifestId($item) ?? ($item['updated_at'] ?? $item['content_url'] ?? '');

        return 'howtoo:pz-published-mod-ids:v2:' . $item['workshop_id'] . ':' . sha1((string) $version);
    }

    /** The cached state of the remote inspection, or null when none was requested. */
    public function remoteState(array $item): ?array
    {
        if (!$this->canInspectRemotely($item)) {
            return null;
        }

        $state = $this->cache->get($this->publishedCacheKey($item));

        return is_array($state) && is_string($state['state'] ?? null) ? $state : null;
    }

    private function queueInspection(array $item): array
    {
        $key = $this->publishedCacheKey($item);
        $queued = ['state' => 'queued', 'queued_at' => time()];
        if (Cache::add($key, $queued, now()->addMinutes(self::PENDING_TTL_MINUTES))) {
            try {
                ResolveWorkshopModIds::dispatch(
                    $key,
                    $this->downloaderAvailable() ? $this->manifestId($item) : null,
                    $this->archiveUrl($item),
                )->onQueue((string) config('howtoo.workshop.queue', 'workshop'));
            } catch (\Throwable $exception) {
                Cache::forget($key);
                Log::warning('Could not queue the Workshop Mod ID inspection.', [
                    'workshop_id' => $item['workshop_id'] ?? null,
                    'error' => $exception->getMessage(),
                ]);

                return ['state' => 'unavailable', 'error' => 'The inspection job could not be queued.'];
            }
        }

        $state = $this->cache->get($key);

        return is_array($state) ? $state : $queued;
    }

    private function isStale(array $state): bool
    {
        $now = time();
        if ($state['state'] === 'running') {
            return $now - (int) ($state['started_at'] ?? $now) > self::RUNNING_STALE_SECONDS;
        }

        return $now - (int) ($state['queued_at'] ?? $now) > self::QUEUED_STALE_SECONDS;
    }

    private function result(array $ids, ?string $source, bool $pending = false, ?string $reason = null): array
    {
        return [
            'mod_ids' => $ids,
            'mod_id_source' => $ids === [] ? null : $source,
            'mod_id_pending' => $pending,
            'mod_id_reason' => $ids === [] && !$pending ? $reason : null,
        ];
    }

    /** @return array{ids: string[], error: ?string} */
    private function fromWorkshopManifest(string $manifest): array
    {
        $downloader = (string) config('howtoo.workshop.downloader');
        if (!$this->downloaderAvailable()) {
            return ['ids' => [], 'error' => "Workshop downloader is not executable: $downloader"];
        }
        if (preg_match('/^[1-9][0-9]{0,19}$/D', $manifest) !== 1) {
            return ['ids' => [], 'error' => 'Invalid Workshop content manifest.'];
        }

        $work = sys_get_temp_dir() . '/howtoo-pz-' . bin2hex(random_bytes(16));
        $download = "$work/download";
        $home = "$work/home";
        if (!@mkdir($download, 0700, true) || !@mkdir($home, 0700)) {
            return ['ids' => [], 'error' => 'Could not create a temporary directory in ' . sys_get_temp_dir()];
        }

        try {
            // DepotDownloader keeps account.config in IsolatedStorage ($HOME/.local/share).
            // Supervisor does not reset HOME when it drops to the worker user, so an
            // unwritable HOME (e.g. /root) makes every download fail. Use a private one.
            $process = new Process([$downloader, $manifest, $download], $work, [
                'HOME' => $home,
                'XDG_DATA_HOME' => "$home/.local/share",
                'XDG_CONFIG_HOME' => "$home/.config",
                'DOTNET_CLI_TELEMETRY_OPTOUT' => '1',
                'DOTNET_NOLOGO' => '1',
            ]);
            $process->setTimeout(self::DOWNLOADER_TIMEOUT_SECONDS);
            $exitCode = $process->run();

            $ids = [];
            foreach (File::allFiles($download, true) as $file) {
                if (!$file->isLink() && strcasecmp($file->getFilename(), 'mod.info') === 0
                    && $file->getSize() <= self::MAX_MOD_INFO_SIZE) {
                    $ids = array_merge($ids, $this->parseModInfo($file->getContents()));
                }
            }
            $ids = $this->normalize($ids);
            if ($ids !== []) {
                return ['ids' => $ids, 'error' => null];
            }

            $output = trim($process->getErrorOutput() . "\n" . $process->getOutput());

            return [
                'ids' => [],
                'error' => sprintf(
                    'Downloader exited with code %d without a usable mod.info. %s',
                    $exitCode,
                    mb_substr($output, -1500),
                ),
            ];
        } catch (\Symfony\Component\Process\Exception\RuntimeException $exception) {
            return ['ids' => [], 'error' => 'Downloader failed: ' . $exception->getMessage()];
        } finally {
            File::deleteDirectory($work);
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
            if (is_array($cached)) {
                if ($cached !== []) {
                    $resolved[$id] = $cached;
                }
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
                    $this->cache->put(
                        $this->cacheKey($server, $id),
                        $modIds,
                        CarbonImmutable::now()->addMinutes(self::INSTALLED_CACHE_MINUTES),
                    );
                    $pending = array_values(array_diff($pending, [$id]));
                }
            }

            if ($pending === []) {
                break;
            }
        }

        // Remember misses briefly so a page full of not-yet-downloaded items does
        // not walk every Workshop root through Wings on each request.
        foreach ($pending as $id) {
            $this->cache->put(
                $this->cacheKey($server, $id),
                [],
                CarbonImmutable::now()->addMinutes(self::INSTALLED_MISS_CACHE_MINUTES),
            );
        }

        return $resolved;
    }

    public function forgetInstalled(Server $server, array $workshopIds): void
    {
        foreach ($workshopIds as $id) {
            $this->cache->forget($this->cacheKey($server, (string) $id));
        }
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

    /**
     * Read "Mod ID" declarations from a Workshop description (BBCode or HTML).
     *
     * Labels at the start of a line ("Mod ID: X", "🆔 Mod IDs (B42): A; B", or a
     * "Mod ID" heading followed by one id per line) are trusted first. Inline
     * mentions such as "Requires Foo (Mod ID: Foo)" usually describe dependencies,
     * so they are only used when the description has no line-level label at all.
     */
    public function fromDescription(string $description): array
    {
        $lines = preg_split('/\R/u', $this->descriptionText($description)) ?: [];
        $label = self::LABEL;
        $qualifier = self::LABEL_QUALIFIER;
        $values = [];

        foreach ($lines as $index => $line) {
            $line = trim($line);
            if (preg_match("/^[\\s\\p{P}\\p{S}]*{$label}\\b{$qualifier}[:=]\\s*(.*)$/iuD", $line, $match) === 1) {
                $value = trim($match[1]);
            } elseif (preg_match("/^[\\s\\p{P}\\p{S}]*{$label}[\\s\\p{P}\\p{S}]*$/iuD", $line) === 1) {
                $value = '';
            } else {
                continue;
            }

            if ($value === '') {
                // The ids are listed on the following lines.
                $values = array_merge($values, $this->followingIds($lines, $index + 1));
                continue;
            }

            $values = array_merge($values, $this->splitDescriptionValue($value));
        }

        if ($values === []) {
            preg_match_all(
                "/\\b{$label}\\s*[:=]\\s*([^\\s;,|()\\[\\]]+(?:\\s*[;,]\\s*[^\\s;,|()\\[\\]]+)*)/iu",
                implode("\n", $lines),
                $matches,
            );
            foreach ($matches[1] as $value) {
                $values = array_merge($values, $this->splitDescriptionValue($value));
            }
        }

        return $this->normalize(array_filter($values, fn (string $value): bool => $this->looksLikeModId($value)));
    }

    public function parseModInfo(string $content): array
    {
        if (str_starts_with($content, "\xFF\xFE") || str_starts_with($content, "\xFE\xFF")) {
            $content = mb_convert_encoding(substr($content, 2), 'UTF-8', str_starts_with($content, "\xFF\xFE") ? 'UTF-16LE' : 'UTF-16BE');
        }
        $content = preg_replace('/^\xEF\xBB\xBF/', '', $content) ?? $content;
        preg_match_all('/^[ \t]*id[ \t]*=[ \t]*([^\r\n]+?)[ \t]*\r?$/im', $content, $matches);

        return $this->normalize($matches[1]);
    }

    /** @return array{ids: string[], error: ?string} */
    private function fromRemoteArchive(string $url): array
    {
        if (!$this->trustedSteamContentUrl($url) || !class_exists(\ZipArchive::class)) {
            return ['ids' => [], 'error' => 'The published file URL is not a trusted Steam content URL.'];
        }

        $temporary = tempnam(storage_path('framework/cache'), 'howtoo-pz-');
        if (!is_string($temporary)) {
            return ['ids' => [], 'error' => 'Could not create a temporary file.'];
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
                return ['ids' => [], 'error' => 'Published archive download failed with HTTP ' . $response->status()];
            }

            $archive = new \ZipArchive();
            if ($archive->open($temporary) !== true) {
                return ['ids' => [], 'error' => 'The published file is not a zip archive.'];
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

                $modIds = $this->normalize($modIds);

                return ['ids' => $modIds, 'error' => $modIds === [] ? 'The published archive has no mod.info.' : null];
            } finally {
                $archive->close();
            }
        } catch (\Throwable $exception) {
            return ['ids' => [], 'error' => 'Published archive inspection failed: ' . $exception->getMessage()];
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

    /** Plain text of a description with one logical block per line. */
    private function descriptionText(string $description): string
    {
        $text = preg_replace('/<br\s*\/?\s*>|<\/?(?:div|p|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|pre)\b[^>]*>/i', "\n", $description) ?? '';
        $text = strip_tags($text);
        $text = preg_replace('/\[\/?(?:' . self::BLOCK_BBCODE . ')(?:=[^\]\r\n]*)?\]/i', "\n", $text) ?? $text;
        $text = preg_replace('/\[\/?(?:' . self::INLINE_BBCODE . ')(?:=[^\]\r\n]*)?\]/i', '', $text) ?? $text;

        return html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    /** Ids written one per line after a bare "Mod ID:" label or heading. */
    private function followingIds(array $lines, int $start): array
    {
        $values = [];
        $label = self::LABEL;
        for ($index = $start, $taken = 0; isset($lines[$index]) && $taken < self::MAX_DESCRIPTION_FOLLOW_LINES; ++$index) {
            $line = trim($lines[$index]);
            if ($line === '') {
                if ($values !== []) {
                    break;
                }
                continue;
            }
            // Stop at the next "Something:" label (Workshop ID, Map Folder, Requirements...).
            if (preg_match("/^[\\s\\p{P}\\p{S}]*(?:{$label}\\b|[\\p{L}\\p{N} ]{2,30}:)/iu", $line) === 1) {
                break;
            }
            $values = array_merge($values, $this->splitDescriptionValue($line));
            ++$taken;
        }

        return $values;
    }

    private function splitDescriptionValue(string $value): array
    {
        // "Mod ID: Foo / Workshop ID: 123" or "Mod ID: Foo | Workshop ID: 123".
        $value = preg_replace('/(?:^|[\s\/|,;-]+)Workshop[ _-]*IDs?\b.*$/iu', '', $value) ?? $value;
        $parts = preg_split('/\s*[;,|]\s*|\s+\/\s+/u', $value) ?: [];

        return collect($parts)
            ->map(function (string $part): string {
                $part = trim($part);
                // Only strip a matching pair of quotes: ids such as "'87Trucks" keep their apostrophe.
                $part = preg_replace('/^(["`]|\x{201C}|\x{2018})(.+)(?:\1|\x{201D}|\x{2019})$/u', '$2', $part) ?? $part;
                // "Foo (B42)" or "Foo - build 41" qualifiers; "Arsenal(26)GunFighter" stays intact.
                $part = preg_replace('/\s+\((?:[^()]*)\)$/u', '', $part) ?? $part;
                $part = preg_replace('/\s+[-\x{2013}\x{2014}]\s+(?:b(?:uild)?\s*4\d[\w.]*|for\s.+)$/iu', '', $part) ?? $part;

                return rtrim($part, " \t.:");
            })
            ->filter()
            ->all();
    }

    private function looksLikeModId(string $value): bool
    {
        $value = trim($value);
        if ($value === '' || mb_strlen($value) > 128 || in_array(mb_strtolower($value), self::PLACEHOLDERS, true)) {
            return false;
        }
        if (preg_match('~://|^www\.|\bsteamcommunity\.com\b~i', $value) === 1) {
            return false;
        }

        return count(preg_split('/\s+/u', $value) ?: []) <= self::MAX_DESCRIPTION_ID_WORDS;
    }

    private function normalize(array $values): array
    {
        return collect($values)
            ->map(fn ($value): string => ltrim(trim((string) $value), '\\'))
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
        return "howtoo:pz-mod-ids:v2:{$server->uuid}:$workshopId";
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
