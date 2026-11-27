<?php

namespace Pterodactyl\Http\Controllers\Api\Client\Servers;

use Carbon\CarbonImmutable;
use Pterodactyl\Models\User;
use Pterodactyl\Enum\JwtScope;
use Pterodactyl\Models\Server;
use Illuminate\Http\JsonResponse;
use Pterodactyl\Models\Permission;
use Pterodactyl\Services\Nodes\NodeJWTService;
use Pterodactyl\Services\HowToo\NodeUploadCapabilityService;
use Pterodactyl\Http\Controllers\Api\Client\ClientApiController;
use Pterodactyl\Http\Requests\Api\Client\Servers\Files\UploadSessionRequest;

class FileUploadSessionController extends ClientApiController
{
    /** The token only authorizes requests; the session itself lives on the node for much longer. */
    private const TOKEN_MINUTES = 15;

    public function __construct(
        private NodeJWTService $jwtService,
        private NodeUploadCapabilityService $capabilities,
    ) {
        parent::__construct();
    }

    /**
     * Tells the browser whether the server's node supports chunked, resumable uploads and, if so, returns a
     * signed token bound to this exact file plus the parameters it needs. Called again whenever the token
     * expires; the session id stays the same, so the upload simply continues.
     *
     * For nodes that run the original Wings it answers `supported: false` and the browser uses the regular
     * upload, so nothing changes for them.
     */
    public function __invoke(UploadSessionRequest $request, Server $server): JsonResponse
    {
        $capabilities = $this->capabilities->forNode($server->node);
        if (is_null($capabilities)) {
            return $this->respond(['supported' => false]);
        }

        $user = $request->user();
        $directory = '/' . trim((string) $request->input('directory', '/'), '/');
        $name = (string) $request->input('name');
        $size = (int) $request->input('size');
        $mtime = (int) $request->input('mtime', 0);

        if ($capabilities['max_size'] > 0 && $size > $capabilities['max_size']) {
            return new JsonResponse([
                'errors' => [[
                    'code' => 'FileTooLargeException',
                    'status' => '422',
                    'detail' => sprintf(
                        'The file is larger than the maximum upload size allowed by this node (%d MB).',
                        intdiv($capabilities['max_size'], 1024 * 1024)
                    ),
                    'meta' => ['max_size' => $capabilities['max_size']],
                ]],
            ], 422);
        }

        $sessionId = $this->sessionId($user, $server, $directory, $name, $size, $mtime);
        $expiresAt = CarbonImmutable::now()->addMinutes(self::TOKEN_MINUTES);

        // Replacing an existing file changes its content, so it needs the permission to update files.
        // Without it the node refuses to replace and the upload is kept, never overwritten.
        $replace = $user->can(Permission::ACTION_FILE_UPDATE, $server);

        $token = $this->jwtService
            ->setExpiresAt($expiresAt)
            ->setUser($user)
            ->setClaims([
                'server_uuid' => $server->uuid,
                'session_id' => $sessionId,
                'directory' => $directory,
                'name' => $name,
                'size' => $size,
                'replace' => $replace,
            ])
            ->setScopes(JwtScope::FileUploadSession)
            ->handle($server->node, $user->id . $server->uuid . $sessionId . bin2hex(random_bytes(8)));

        return $this->respond([
            'supported' => true,
            'base_url' => $server->node->getConnectionAddress(),
            'token' => $token->toString(),
            'session_id' => $sessionId,
            'replace' => $replace,
            'chunk_size' => $capabilities['chunk_size'],
            'max_parallel_chunks' => $capabilities['max_parallel_chunks'],
            'max_size' => $capabilities['max_size'],
            'http2' => $capabilities['http2'],
            'expires_at' => $expiresAt->toIso8601String(),
        ]);
    }

    /**
     * A session id derived from everything that identifies the upload, so picking the same file again (even after
     * closing the browser) yields the same id without the panel storing anything. It is keyed with the application
     * key and includes the user, so ids cannot be guessed and are never shared between users.
     */
    private function sessionId(User $user, Server $server, string $directory, string $name, int $size, int $mtime): string
    {
        $material = json_encode([$user->uuid, $server->uuid, $directory, $name, $size, $mtime], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        return substr(hash_hmac('sha256', $material, (string) config('app.key')), 0, 32);
    }

    private function respond(array $attributes): JsonResponse
    {
        return new JsonResponse(['object' => 'upload_session', 'attributes' => $attributes]);
    }
}
