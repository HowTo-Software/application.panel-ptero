<?php

namespace Pterodactyl\Tests\Integration\Http\Controllers\Auth;

use Pterodactyl\Models\User;
use Illuminate\Support\Facades\Event;
use Laravel\Socialite\Facades\Socialite;
use Pterodactyl\Events\Auth\DirectLogin;
use Laravel\Socialite\Contracts\Provider;
use PHPUnit\Framework\Attributes\TestWith;
use Laravel\Socialite\Two\User as SocialiteUser;
use Pterodactyl\Tests\Integration\Http\HttpTestCase;

/**
 * Single sign-on account matching. Authentik is replaced by a stubbed Socialite
 * provider, so only the identity it reports is under test.
 */
class OAuthControllerTest extends HttpTestCase
{
    public function setUp(): void
    {
        parent::setUp();

        Event::fake([DirectLogin::class]);

        config()->set('services.authentik.base_url', 'https://auth.example.com');
        config()->set('services.authentik.client_id', 'panel');
        config()->set('services.authentik.client_secret', 'secret');
        config()->set('services.authentik.customer_group', 'hts-customers');
    }

    /**
     * A website customer signs in to the account the website provisioned for it.
     */
    #[TestWith(['hts-trial-user:0123456789abcdef0123456789abcdef'])]
    #[TestWith(['hts-customer:0b5bb1bc-5c45-4d5b-8a8e-8a5f0f3b5f1e'])]
    public function testCustomerGroupIdentitySignsInToWebsiteProvisionedAccount(string $externalId): void
    {
        $user = User::factory()->create(['email' => 'player@example.com', 'external_id' => $externalId]);
        $this->identity('Player@Example.com', ['hts-customers']);

        $this->get(route('auth.oauth.callback'))->assertRedirect('/');

        $this->assertAuthenticatedAs($user);
    }

    /**
     * Customer identities never reach directory, administrator or unrelated
     * accounts, and identities outside the customer group still reach only
     * AD-owned accounts.
     */
    #[TestWith(['ad-1234', false, ['hts-customers']])]
    #[TestWith(['hts-customer:admin', true, ['hts-customers']])]
    #[TestWith([null, false, ['hts-customers']])]
    #[TestWith(['hts-trial-user:0123456789abcdef0123456789abcdef', false, ['staff']])]
    public function testIdentityCannotReachAnAccountOutsideItsClass(?string $externalId, bool $admin, array $groups): void
    {
        User::factory()->create(['email' => 'player@example.com', 'external_id' => $externalId, 'root_admin' => $admin]);
        $this->identity('player@example.com', $groups);

        $this->get(route('auth.oauth.callback'))->assertRedirect(route('auth.login'));

        $this->assertGuest();
    }

    public function testDirectoryIdentityStillSignsInToItsAccount(): void
    {
        $user = User::factory()->create(['email' => 'staff@example.com', 'external_id' => 'ad-1234']);
        $this->identity('staff@example.com', ['staff']);

        $this->get(route('auth.oauth.callback'))->assertRedirect('/');

        $this->assertAuthenticatedAs($user);
    }

    public function testCustomerSignInStaysOffUntilTheGroupIsConfigured(): void
    {
        config()->set('services.authentik.customer_group', null);
        User::factory()->create(['email' => 'player@example.com', 'external_id' => 'hts-trial-user:0123456789abcdef0123456789abcdef']);
        $this->identity('player@example.com', ['hts-customers']);

        $this->get(route('auth.oauth.callback'))->assertRedirect(route('auth.login'));

        $this->assertGuest();
    }

    private function identity(string $email, array $groups): void
    {
        $identity = (new SocialiteUser())
            ->setRaw(['sub' => 'subject', 'email' => $email, 'groups' => $groups])
            ->map(['id' => 'subject', 'email' => $email]);

        $provider = \Mockery::mock(Provider::class);
        $provider->expects('user')->andReturn($identity);

        Socialite::shouldReceive('driver')->with('authentik')->andReturn($provider);
    }
}
