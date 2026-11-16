<?php

namespace Pterodactyl\Services\HowToo;

use Pterodactyl\Models\Server;
use GuzzleHttp\Exception\RequestException;
use Pterodactyl\Exceptions\DisplayException;
use Pterodactyl\Repositories\Wings\DaemonFileRepository;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;
use Pterodactyl\Exceptions\Http\Connection\DaemonConnectionException;

final class ZomboidWorkshopConfigService
{
    public const MOD_ID_PATTERN = '/^[^;\p{C}\p{Zl}\p{Zp}]{1,128}$/uD';

    public function __construct(
        private DaemonFileRepository $files,
        private ServerGameContext $gameContext,
    ) {
    }

    public function read(Server $server): array
    {
        $context = $this->assertProjectZomboid($server);
        [$path, $content] = $this->locate($server, $context['zomboid_server_name']);

        return array_merge($this->parseContent($content), [
            'path' => $path,
            'revision' => hash('sha256', $content),
        ]);
    }

    public function save(Server $server, array $workshopItems, array $mods, string $revision): array
    {
        $context = $this->assertProjectZomboid($server);
        [$path, $current] = $this->locate($server, $context['zomboid_server_name']);

        if (!hash_equals(hash('sha256', $current), $revision)) {
            throw new ConflictHttpException('The Project Zomboid configuration changed after this page was opened. Reload before saving.');
        }

        $workshopItems = $this->normalizeWorkshopItems($workshopItems);
        $mods = $this->normalizeModIds($mods);
        $updated = $this->updateContent($current, $workshopItems, $mods);

        $this->files->setServer($server)->putContent($path, $updated);

        return [
            'path' => $path,
            'revision' => hash('sha256', $updated),
            'workshop_items' => $workshopItems,
            'mods' => $mods,
        ];
    }

    public function parseContent(string $content): array
    {
        $values = ['WorkshopItems' => [], 'Mods' => []];
        foreach (preg_split('/\R/', $content) ?: [] as $line) {
            if (preg_match('/^\s*(WorkshopItems|Mods)\s*=\s*(.*)$/', $line, $matches) !== 1) {
                continue;
            }

            $values[$matches[1]] = $this->split((string) $matches[2]);
        }

        return [
            'workshop_items' => $this->normalizeWorkshopItems($values['WorkshopItems']),
            'mods' => $this->normalizeModIds($values['Mods']),
        ];
    }

    public function updateContent(string $content, array $workshopItems, array $mods): string
    {
        $newline = str_contains($content, "\r\n") ? "\r\n" : "\n";
        $trailingNewline = preg_match('/\R\z/', $content) === 1;
        $lines = preg_split('/\R/', $content) ?: [];
        if ($trailingNewline && end($lines) === '') {
            array_pop($lines);
        }

        $replacements = [
            'WorkshopItems' => implode(';', $this->normalizeWorkshopItems($workshopItems)),
            'Mods' => implode(';', $this->normalizeModIds($mods)),
        ];
        $seen = [];
        $output = [];

        foreach ($lines as $line) {
            if (preg_match('/^(\s*)(WorkshopItems|Mods)\s*=.*$/', $line, $matches) === 1) {
                $key = $matches[2];
                if (isset($seen[$key])) {
                    continue;
                }

                $seen[$key] = true;
                $output[] = $matches[1] . $key . '=' . $replacements[$key];
                continue;
            }

            $output[] = $line;
        }

        foreach ($replacements as $key => $value) {
            if (!isset($seen[$key])) {
                $output[] = "$key=$value";
            }
        }

        return implode($newline, $output) . ($trailingNewline ? $newline : '');
    }

    private function locate(Server $server, string $serverName): array
    {
        $candidates = array_values(array_unique([
            "/.cache/Server/$serverName.ini",
            "/Zomboid/Server/$serverName.ini",
            "/.cache/Zomboid/Server/$serverName.ini",
            "/$serverName.ini",
        ]));
        $repository = $this->files->setServer($server);

        foreach ($candidates as $path) {
            try {
                return [$path, $repository->getContent($path, 2 * 1024 * 1024)];
            } catch (DaemonConnectionException $exception) {
                if (!$this->isMissingPath($exception)) {
                    throw new DisplayException('Could not read the Project Zomboid configuration from Wings.');
                }

                // Continue through the small fixed allow-list of valid PZ paths.
            }
        }

        throw new DisplayException('Could not find the Project Zomboid server configuration file.');
    }

    private function assertProjectZomboid(Server $server): array
    {
        $context = $this->gameContext->for($server);
        if (!$context['project_zomboid']) {
            throw new DisplayException('Workshop Manager is only available for Project Zomboid servers.');
        }

        return $context;
    }

    private function split(string $value): array
    {
        return collect(explode(';', $value))
            ->map(fn (string $entry): string => trim($entry))
            ->filter()
            ->values()
            ->all();
    }

    private function normalizeWorkshopItems(array $items): array
    {
        return collect($items)
            ->map(fn ($item): string => trim((string) $item))
            ->filter(fn (string $item): bool => preg_match('/^\d{1,20}$/', $item) === 1)
            ->unique()
            ->take(500)
            ->values()
            ->all();
    }

    private function normalizeModIds(array $mods): array
    {
        return collect($mods)
            ->map(fn ($mod): string => trim((string) $mod))
            ->filter(fn (string $mod): bool => preg_match(self::MOD_ID_PATTERN, $mod) === 1)
            ->unique()
            ->take(500)
            ->values()
            ->all();
    }

    private function isMissingPath(DaemonConnectionException $exception): bool
    {
        $previous = $exception->getPrevious();
        if (!$previous instanceof RequestException || !$previous->hasResponse()) {
            return false;
        }

        $response = $previous->getResponse();
        if ($response->getStatusCode() === 404) {
            return true;
        }

        if ($response->getStatusCode() !== 500) {
            return false;
        }

        $body = mb_strtolower($response->getBody()->__toString());
        $decoded = json_decode($body, true);
        $message = is_array($decoded) && is_string($decoded['error'] ?? null)
            ? $decoded['error']
            : $body;

        return str_contains($message, 'no such file or directory')
            || str_contains($message, 'file does not exist')
            || str_contains($message, 'path does not exist')
            || str_contains($message, 'not found');
    }
}
