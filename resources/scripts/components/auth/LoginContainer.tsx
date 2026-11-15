import React, { useEffect } from 'react';
import { AuthPageShell, FormSurface } from '@/components/auth/LoginFormContainer';
import { useStoreState } from 'easy-peasy';
import tw from 'twin.macro';
import Button from '@/components/elements/Button';
import useFlash from '@/plugins/useFlash';
import { useTranslation } from 'react-i18next';

const LoginContainer = () => {
    const { clearFlashes, addFlash } = useFlash();
    const { t } = useTranslation('strings');
    const ssoEnabled = useStoreState((state) => state.settings.data!.sso?.enabled ?? false);
    const recoveryUrl = useStoreState((state) => state.settings.data!.sso?.recoveryUrl ?? '');
    const ssoError = useStoreState((state) => state.settings.data!.sso?.error ?? '');

    useEffect(() => {
        clearFlashes();
        // A refused SSO sign-in lands back here. Without the reason the page looks
        // unchanged, so every retry appears to loop.
        if (ssoError) {
            addFlash({ type: 'error', message: ssoError });
        }
    }, []);

    return (
        <AuthPageShell title={t('auth.login_title')}>
            <FormSurface>
                {/* Full page loads, not router links: both flows leave the SPA. */}
                {ssoEnabled && (
                    <a href={'/auth/oauth/redirect/authentik'} css={tw`block`}>
                        <Button type={'button'} size={'xlarge'} css={tw`w-full`}>
                            {t('auth.sso_login')}
                        </Button>
                    </a>
                )}
                {recoveryUrl.length > 0 && (
                    <div css={tw`mt-6 text-center`}>
                        <a
                            href={recoveryUrl}
                            css={tw`text-xs text-neutral-500 tracking-wide no-underline uppercase hover:text-neutral-600`}
                        >
                            {t('auth.forgot_password')}
                        </a>
                    </div>
                )}
            </FormSurface>
        </AuthPageShell>
    );
};

export default LoginContainer;
