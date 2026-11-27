<?php

namespace Pterodactyl\Tests\Integration\Api\Client\Server\Files;

use Mockery\MockInterface;
use Lcobucci\JWT\Configuration;
use Pterodactyl\Models\Permission;
use Lcobucci\JWT\Signer\Hmac\Sha256;
use Lcobucci\JWT\Signer\Key\InMemory;
use Lcobucci\JWT\Validation\Constraint\SignedWith;
use Pterodactyl\Services\HowToo\NodeUploadCapabilityService;
use Pterodactyl\Repositories\Wings\DaemonConfigurationRepository;
use Pterodactyl\Tests\Integration\Api\Client\ClientApiIntegrationTestCase;

class FileUploadSessionTest extends ClientApiIntegrationTestCase
{
    private function capableNode(): array
    {
        return [
            'version' => 'v1.13.4',
            'capabilities' => [
                'howto_upload_sessions' => [
                    'version' => 1,
                    'chunk_size' => 16777216,
                    'max_parallel_chunks' => 8,
                    'max_size' => 10 * 1024 * 1024 * 1024,
                    'hash' => 'sha256',
                    'http2' => true,
                ],
            ],
        ];
    }

    private function mockWings(array $systemInformation, int $times = 1): void
    {
        $this->mock(DaemonConfigurationRepository::class, function (MockInterface $mock) use ($systemInformation, $times) {
            $mock->expects('setNode->getSystemInformation')->with(2)->times($times)->andReturn($systemInformation);
        });
    }

    private function query(string $name = 'backup.rar', int $size = 160200000, int $mtime = 1700000000000, string $directory = '/mods/deathmatch/backups'): string
    {
        return '?' . http_build_query(compact('directory', 'name', 'size', 'mtime'));
    }

    public function testEndpointRequiresTheCreateFilePermission(): void
    {
        [$user, $server] = $this->generateTestAccount([Permission::ACTION_CONTROL_CONSOLE]);

        $this->getJson($this->link($server, '/files/upload-session') . $this->query())->assertUnauthorized();

        $this->actingAs($user)
            ->getJson($this->link($server, '/files/upload-session') . $this->query())
            ->assertForbidden();
    }

    public function testNodesRunningTheOriginalWingsAreToldToUseTheRegularUpload(): void
    {
        [$user, $server] = $this->generateTestAccount([Permission::ACTION_FILE_CREATE]);

        // Upstream Wings does not send a "capabilities" key at all.
        $this->mockWings(['version' => 'v1.13.4']);

        $this->actingAs($user)
            ->getJson($this->link($server, '/files/upload-session') . $this->query())
            ->assertOk()
            ->assertJsonPath('object', 'upload_session')
            ->assertJsonPath('attributes.supported', false)
            ->assertJsonMissingPath('attributes.token');
    }

    public function testAnUnreachableNodeFallsBackInsteadOfFailing(): void
    {
        [$user, $server] = $this->generateTestAccount([Permission::ACTION_FILE_CREATE]);

        $this->mock(DaemonConfigurationRepository::class, function (MockInterface $mock) {
            $mock->expects('setNode->getSystemInformation')->andThrow(new \RuntimeException('connection refused'));
        });

        $this->actingAs($user)
            ->getJson($this->link($server, '/files/upload-session') . $this->query())
            ->assertOk()
            ->assertJsonPath('attributes.supported', false);
    }

    public function testMalformedCapabilitiesAreNotTrusted(): void
    {
        $this->assertNull(NodeUploadCapabilityService::normalize(null));
        $this->assertNull(NodeUploadCapabilityService::normalize('yes'));
        $this->assertNull(NodeUploadCapabilityService::normalize(['version' => 2, 'chunk_size' => 16777216, 'max_parallel_chunks' => 8]));
        $this->assertNull(NodeUploadCapabilityService::normalize(['version' => 1, 'chunk_size' => 10, 'max_parallel_chunks' => 8]));
        $this->assertNull(NodeUploadCapabilityService::normalize(['version' => 1, 'chunk_size' => 16777216, 'max_parallel_chunks' => 0]));
        $this->assertNull(NodeUploadCapabilityService::normalize(['version' => 1, 'chunk_size' => 16777216, 'max_parallel_chunks' => 8, 'hash' => 'md5']));

        // The panel never asks for more parallelism than it is able to use.
        $this->assertSame(8, NodeUploadCapabilityService::normalize(['version' => 1, 'chunk_size' => 16777216, 'max_parallel_chunks' => 64])['max_parallel_chunks']);
    }

    public function testASignedTokenBoundToTheFileIsReturnedForCapableNodes(): void
    {
        /** @var \Pterodactyl\Models\User $user */
        /** @var \Pterodactyl\Models\Server $server */
        [$user, $server] = $this->generateTestAccount();

        $this->mockWings($this->capableNode());

        $response = $this->actingAs($user)
            ->getJson($this->link($server, '/files/upload-session') . $this->query())
            ->assertOk()
            ->assertJsonPath('attributes.supported', true)
            ->assertJsonPath('attributes.chunk_size', 16777216)
            ->assertJsonPath('attributes.max_parallel_chunks', 8)
            ->assertJsonPath('attributes.replace', true)
            ->assertJsonPath('attributes.base_url', $server->node->getConnectionAddress());

        $this->assertMatchesRegularExpression('/^[a-f0-9]{32}$/', $response->json('attributes.session_id'));

        $config = Configuration::forSymmetricSigner(new Sha256(), $key = InMemory::plainText($server->node->getDecryptedKey()));
        $config = $config->withValidationConstraints(new SignedWith(new Sha256(), $key));

        /** @var \Lcobucci\JWT\Token\Plain $token */
        $token = $config->parser()->parse($response->json('attributes.token'));

        $this->assertTrue($config->validator()->validate($token, ...$config->validationConstraints()), 'The token must be signed with the node key.');
        $this->assertSame('upload-session', $token->claims()->get('scope'));
        $this->assertSame($server->uuid, $token->claims()->get('server_uuid'));
        $this->assertSame($user->uuid, $token->claims()->get('user_uuid'));
        $this->assertSame($response->json('attributes.session_id'), $token->claims()->get('session_id'));
        $this->assertSame('/mods/deathmatch/backups', $token->claims()->get('directory'));
        $this->assertSame('backup.rar', $token->claims()->get('name'));
        $this->assertSame(160200000, $token->claims()->get('size'));
        $this->assertTrue($token->claims()->get('replace'));

        // Valid for about 15 minutes, like the regular upload token.
        $lifetime = $token->claims()->get('exp')->getTimestamp() - $token->claims()->get('iat')->getTimestamp();
        $this->assertEqualsWithDelta(15 * 60, $lifetime, 5);
    }

    public function testTheSessionIdIsStableForTheSameFileAndDifferentOtherwise(): void
    {
        [$user, $server] = $this->generateTestAccount();
        $this->mockWings($this->capableNode());
        $url = $this->link($server, '/files/upload-session');

        $id = fn (string $query) => $this->actingAs($user)->getJson($url . $query)->assertOk()->json('attributes.session_id');

        $same = $id($this->query());

        // Reopening the browser and picking the same file gives the same id, so the upload resumes...
        $this->assertSame($same, $id($this->query()));

        // ...while a different file, a modified file or another directory is a different upload.
        $this->assertNotSame($same, $id($this->query('other.rar')));
        $this->assertNotSame($same, $id($this->query('backup.rar', 160200001)));
        $this->assertNotSame($same, $id($this->query('backup.rar', 160200000, 1700000000001)));
        $this->assertNotSame($same, $id($this->query('backup.rar', 160200000, 1700000000000, '/elsewhere')));
    }

    public function testSessionIdsAreNeverSharedBetweenUsers(): void
    {
        // generateTestAccount() creates a subuser on a server owned by somebody else.
        [$subuser, $server] = $this->generateTestAccount([Permission::ACTION_FILE_CREATE]);
        $owner = $server->user;
        $this->mockWings($this->capableNode());
        $url = $this->link($server, '/files/upload-session') . $this->query();

        $ownerId = $this->actingAs($owner)->getJson($url)->assertOk()->json('attributes.session_id');
        $subuserId = $this->actingAs($subuser)->getJson($url)->assertOk()->json('attributes.session_id');

        // Same file, same server: still different sessions, so one user can never resume or touch the other's upload.
        $this->assertNotSame($ownerId, $subuserId);
    }

    public function testReplacingAnExistingFileRequiresThePermissionToUpdateFiles(): void
    {
        [$user, $server] = $this->generateTestAccount([Permission::ACTION_FILE_CREATE]);
        $this->mockWings($this->capableNode());

        $this->actingAs($user)
            ->getJson($this->link($server, '/files/upload-session') . $this->query())
            ->assertOk()
            ->assertJsonPath('attributes.supported', true)
            ->assertJsonPath('attributes.replace', false);
    }

    public function testFilesLargerThanTheNodeLimitAreRefusedBeforeUploading(): void
    {
        [$user, $server] = $this->generateTestAccount();
        $this->mockWings($this->capableNode());

        $this->actingAs($user)
            ->getJson($this->link($server, '/files/upload-session') . $this->query('huge.bin', 11 * 1024 * 1024 * 1024))
            ->assertStatus(422)
            ->assertJsonPath('errors.0.code', 'FileTooLargeException');
    }

    public function testCapabilitiesAreCachedPerNode(): void
    {
        [$user, $server] = $this->generateTestAccount();

        // Wings is asked only once even though two requests are made.
        $this->mockWings($this->capableNode(), 1);
        $url = $this->link($server, '/files/upload-session');

        $this->actingAs($user)->getJson($url . $this->query())->assertOk();
        $this->getJson($url . $this->query('second.rar'))->assertOk()->assertJsonPath('attributes.supported', true);
    }

    public function testValidation(): void
    {
        [$user, $server] = $this->generateTestAccount();
        $this->mockWings($this->capableNode(), 0);

        $this->actingAs($user)
            ->getJson($this->link($server, '/files/upload-session'))
            ->assertUnprocessable()
            ->assertJsonPath('errors.0.meta.source_field', 'name');

        $this->getJson($this->link($server, '/files/upload-session') . '?name=a&size=-1')
            ->assertUnprocessable()
            ->assertJsonPath('errors.0.meta.source_field', 'size');
    }
}
