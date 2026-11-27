<?php

namespace Pterodactyl\Services\HowToo;

use Pterodactyl\Models\Node;
use Illuminate\Contracts\Cache\Repository as CacheRepository;
use Pterodactyl\Repositories\Wings\DaemonConfigurationRepository;

/**
 * Detects whether a node runs the HowTo.Software build of Wings, which supports chunked, resumable uploads.
 *
 * Wings advertises the feature under `capabilities.howto_upload_sessions` in `GET /api/system?v=2`.
 * Upstream Wings does not send that key, which is how nodes running the original Wings are told apart
 * (and keep using the regular upload). Panels with nodes of both kinds therefore work without any setting.
 */
class NodeUploadCapabilityService
{
    /** How long a successful answer is remembered. */
    public const CACHE_TTL_SECONDS = 300;

    /** How long a failure (node offline, timeout) is remembered, so an offline node does not slow every upload. */
    public const FAILURE_TTL_SECONDS = 30;

    public function __construct(
        private DaemonConfigurationRepository $repository,
        private CacheRepository $cache,
    ) {
    }

    /**
     * Returns the normalized upload capabilities of the node, or null when it does not support chunked uploads
     * (original Wings, feature disabled, or node unreachable).
     *
     * @return array{version: int, chunk_size: int, max_parallel_chunks: int, max_size: int, http2: bool}|null
     */
    public function forNode(Node $node): ?array
    {
        $key = "node:$node->id:upload-capabilities";

        $cached = $this->cache->get($key);
        if (is_array($cached)) {
            return $cached['capabilities'];
        }

        try {
            $information = $this->repository->setNode($node)->getSystemInformation(2);
        } catch (\Throwable) {
            $this->cache->put($key, ['capabilities' => null], self::FAILURE_TTL_SECONDS);

            return null;
        }

        $capabilities = static::normalize($information['capabilities']['howto_upload_sessions'] ?? null);
        $this->cache->put($key, ['capabilities' => $capabilities], self::CACHE_TTL_SECONDS);

        return $capabilities;
    }

    /**
     * Validates what the node reported. Anything unexpected is treated as "not supported" rather than trusted.
     *
     * @return array{version: int, chunk_size: int, max_parallel_chunks: int, max_size: int, http2: bool}|null
     */
    public static function normalize(mixed $raw): ?array
    {
        if (!is_array($raw) || ($raw['version'] ?? null) !== 1 || ($raw['hash'] ?? 'sha256') !== 'sha256') {
            return null;
        }

        $chunkSize = $raw['chunk_size'] ?? null;
        $parallel = $raw['max_parallel_chunks'] ?? null;
        if (!is_int($chunkSize) || $chunkSize < 1024 * 1024 || $chunkSize > 256 * 1024 * 1024) {
            return null;
        }
        if (!is_int($parallel) || $parallel < 1) {
            return null;
        }

        $maxSize = $raw['max_size'] ?? 0;

        return [
            'version' => 1,
            'chunk_size' => $chunkSize,
            'max_parallel_chunks' => min($parallel, 8),
            'max_size' => is_int($maxSize) && $maxSize > 0 ? $maxSize : 0,
            'http2' => (bool) ($raw['http2'] ?? true),
        ];
    }
}
