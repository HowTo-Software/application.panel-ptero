<?php

namespace Pterodactyl\Tests\Integration\Http\Controllers\Auth;

use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Password;
use Pterodactyl\Models\User;
use Pterodactyl\Notifications\AccountCreated;
use Pterodactyl\Notifications\SendPasswordReset;
use Pterodactyl\Services\Users\LocalAuthentication;
use Pterodactyl\Tests\Integration\Http\HttpTestCase;

class LegacyAuthenticationTest extends HttpTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        config([
            'auth.local_login_enabled' => true,
            'services.authentik.base_url' => 'https://auth.example.test',
            'services.authentik.client_id' => 'test-client',
            'services.authentik.client_secret' => 'test-secret',
            'recaptcha.enabled' => false,
        ]);
    }

    public function testLocalCustomerCanSignInWithSsoConfigured(): void
    {
        $user = User::factory()->create(['password' => Hash::make('test-password-123'), 'external_id' => null, 'use_totp' => false]);
        $this->postJson('/auth/login', ['user' => $user->email, 'password' => 'test-password-123'])
            ->assertOk()->assertJsonPath('data.complete', true);
        $this->assertAuthenticatedAs($user);
    }

    public function testDirectoryPasswordCannotBypassSso(): void
    {
        $user = User::factory()->create(['password' => Hash::make('test-password-123'), 'external_id' => 'ad-test']);
        $response = $this->postJson('/auth/login', ['user' => $user->email, 'password' => 'test-password-123']);
        $this->assertFalse($response->isSuccessful());
        $this->assertGuest();
    }

    public function testLocalCustomerGetsAResetNotification(): void
    {
        Notification::fake();
        $user = User::factory()->create(['external_id' => null]);
        $this->postJson('/auth/password', ['email' => $user->email])->assertOk();
        Notification::assertSentTo($user, SendPasswordReset::class);
    }

    public function testDirectoryAccountDoesNotGetALocalResetNotification(): void
    {
        Notification::fake();
        $user = User::factory()->create(['external_id' => 'ad-test']);
        $this->postJson('/auth/password', ['email' => $user->email])->assertOk();
        Notification::assertNothingSent();
    }

    public function testDirectoryAccountCannotRedeemAPreviouslyIssuedLocalResetToken(): void
    {
        $user = User::factory()->create(['external_id' => 'ad-test']);
        $token = Password::broker()->createToken($user);
        $oldHash = $user->password;
        $response = $this->postJson('/auth/password/reset', [
            'email' => $user->email, 'token' => $token, 'password' => 'changed-password-123',
            'password_confirmation' => 'changed-password-123',
        ]);
        $this->assertFalse($response->isSuccessful());
        $this->assertSame($oldHash, $user->fresh()->password);
        $this->assertGuest();
    }

    public function testLocalCustomerCanRedeemFirstAccessToken(): void
    {
        $user = User::factory()->create(['external_id' => null, 'use_totp' => false]);
        $token = Password::broker()->createToken($user);
        $this->postJson('/auth/password/reset', [
            'email' => $user->email, 'token' => $token, 'password' => 'changed-password-123',
            'password_confirmation' => 'changed-password-123',
        ])->assertOk()->assertJsonPath('success', true);
        $this->assertTrue(Hash::check('changed-password-123', $user->fresh()->password));
    }

    public function testWelcomeEmailKeepsLocalSetupLinkWhenSsoIsEnabled(): void
    {
        $user = User::factory()->create(['external_id' => null]);
        $mail = (new AccountCreated($user, 'first-access-test-token'))->toMail();
        $this->assertStringContainsString('/auth/password/reset/first-access-test-token', $mail->actionUrl);
    }

    public function testPolicyProtectsPrivilegedAndUnknownManagedAccounts(): void
    {
        $this->assertTrue(LocalAuthentication::allows(User::factory()->make(['external_id' => 'hts-customer:test'])));
        $this->assertTrue(LocalAuthentication::allows(User::factory()->make(['external_id' => 'hts-trial-user:test'])));
        $this->assertFalse(LocalAuthentication::allows(User::factory()->make(['external_id' => 'other-managed:test'])));
        $this->assertFalse(LocalAuthentication::allows(User::factory()->admin()->make(['external_id' => null])));
        config(['auth.local_login_enabled' => false]);
        $this->assertFalse(LocalAuthentication::allows(User::factory()->make(['external_id' => null])));
        $this->postJson('/auth/login', ['user' => 'test@example.test', 'password' => 'test-password'])->assertNotFound();
    }
}
