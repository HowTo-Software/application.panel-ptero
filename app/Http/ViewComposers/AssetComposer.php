<?php

namespace Pterodactyl\Http\ViewComposers;

use Illuminate\View\View;
use Pterodactyl\Services\Users\LocalAuthentication;
use Illuminate\Support\ViewErrorBag;
use Pterodactyl\Services\Helpers\AssetHashService;

class AssetComposer
{
    /**
     * AssetComposer constructor.
     */
    public function __construct(private AssetHashService $assetHashService)
    {
    }

    /**
     * Provide access to the asset service in the views.
     */
    public function compose(View $view): void
    {
        $authentik = config('services.authentik');
        $ssoEnabled = !empty($authentik['client_id']) && !empty($authentik['client_secret']) && !empty($authentik['base_url']);
        $flow = fn (string $slug) => rtrim($authentik['base_url'], '/') . '/if/flow/' . trim($slug, '/') . '/';

        $view->with('asset', $this->assetHashService);
        $view->with('siteConfiguration', [
            'name' => config('app.name') ?? 'Pterodactyl',
            'locale' => config('app.locale') ?? 'en',
            'recaptcha' => [
                'enabled' => config('recaptcha.enabled', false),
                'siteKey' => config('recaptcha.website_key') ?? '',
            ],
            'localAuthEnabled' => LocalAuthentication::enabled(),
            'sso' => [
                'enabled' => $ssoEnabled,
                // Passwords live in Active Directory, so recovery is Authentik's flow, not ours.
                'recoveryUrl' => $ssoEnabled ? $flow($authentik['recovery_flow']) : '',
                // Same store, so a signed-in user changes their password there too. This
                // flow requires an Authentik session; the recovery one requires no session.
                'passwordChangeUrl' => $ssoEnabled ? $flow($authentik['password_change_flow']) : '',
                // Why the last sign-in was refused. OAuthController flashes it on the redirect
                // back to the login page, which otherwise looks exactly as it did before.
                'error' => $this->ssoError(),
            ],
        ]);
    }

    private function ssoError(): string
    {
        $request = request();
        $errors = $request->hasSession() ? $request->session()->get('errors') : null;

        return $errors instanceof ViewErrorBag ? $errors->first('sso') : '';
    }
}
