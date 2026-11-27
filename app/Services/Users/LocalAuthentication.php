<?php

namespace Pterodactyl\Services\Users;

use Pterodactyl\Models\User;

/**
 * Local credentials are an alternative for customers, not a way to bypass
 * directory or privileged-account authentication when SSO is configured.
 */
final class LocalAuthentication
{
    public static function enabled(): bool
    {
        return (bool) config('auth.local_login_enabled', true);
    }

    public static function ssoEnabled(): bool
    {
        return !empty(config('services.authentik.base_url'))
            && !empty(config('services.authentik.client_id'))
            && !empty(config('services.authentik.client_secret'));
    }

    public static function allows(User $user): bool
    {
        if (!self::enabled()) {
            return false;
        }

        // Keep the upstream behavior for installations that do not use SSO.
        if (!self::ssoEnabled()) {
            return true;
        }

        if ($user->root_admin) {
            return false;
        }

        $externalId = $user->external_id;

        return $externalId === null || $externalId === ''
            || str_starts_with($externalId, 'hts-customer:')
            || str_starts_with($externalId, 'hts-trial-user:');
    }
}
