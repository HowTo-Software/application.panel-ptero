import React, { useRef } from 'react';
import { Link, useHistory } from 'react-router-dom';
import { Formik, FormikHelpers } from 'formik';
import { object, string } from 'yup';
import Reaptcha from 'reaptcha';
import tw from 'twin.macro';
import { useTranslation } from 'react-i18next';
import { useStoreState } from '@/state/hooks';
import LoginFormContainer from '@/components/auth/LoginFormContainer';
import Field from '@/components/elements/Field';
import Button from '@/components/elements/Button';
import login from '@/api/auth/login';
import { httpErrorToHuman } from '@/api/http';
import useFlash from '@/plugins/useFlash';

interface Values {
    username: string;
    password: string;
}

export default () => {
    const { t } = useTranslation('strings');
    const history = useHistory();
    const { clearFlashes, addFlash } = useFlash();
    const recaptcha = useStoreState((state) => state.settings.data!.recaptcha);
    const captcha = useRef<Reaptcha>(null);
    const captchaToken = useRef<string | null>(null);

    const submit = async (values: Values, { setSubmitting }: FormikHelpers<Values>) => {
        clearFlashes();
        if (recaptcha.enabled && !captchaToken.current) {
            try {
                if (!captcha.current) {
                    throw new Error(t('auth.login_unavailable'));
                }
                await captcha.current.execute();
            } catch (error) {
                setSubmitting(false);
                addFlash({ type: 'error', message: httpErrorToHuman(error) });
            }
            return;
        }

        try {
            const response = await login({ ...values, recaptchaData: captchaToken.current });
            if (response.complete) {
                window.location.assign(response.intended || '/');
            } else if (response.confirmationToken) {
                history.push('/auth/login/checkpoint', { token: response.confirmationToken });
            } else {
                throw new Error(t('auth.login_unavailable'));
            }
        } catch (error) {
            addFlash({ type: 'error', message: httpErrorToHuman(error) });
        } finally {
            captchaToken.current = null;
            captcha.current?.reset();
            setSubmitting(false);
        }
    };

    return (
        <Formik
            initialValues={{ username: '', password: '' }}
            onSubmit={submit}
            validationSchema={object().shape({
                username: string().required(t('auth.username_required')),
                password: string().required(t('auth.password_required')),
            })}
        >
            {({ isSubmitting, submitForm, setSubmitting }) => (
                <LoginFormContainer title={t('auth.legacy_login')}>
                    <Field light id={'legacy-username'} name={'username'} label={t('auth.legacy_identifier')} autoComplete={'username'} autoFocus />
                    <div css={tw`mt-6`}>
                        <Field light id={'legacy-password'} name={'password'} label={t('password')} type={'password'} autoComplete={'current-password'} />
                    </div>
                    <div css={tw`mt-6`}>
                        <Button type={'submit'} size={'xlarge'} disabled={isSubmitting} isLoading={isSubmitting} css={tw`w-full`}>
                            {t('login')}
                        </Button>
                    </div>
                    {recaptcha.enabled && (
                        <Reaptcha
                            ref={captcha}
                            size={'invisible'}
                            sitekey={recaptcha.siteKey || '_invalid_key'}
                            onVerify={(token) => {
                                captchaToken.current = token;
                                submitForm();
                            }}
                            onExpire={() => {
                                captchaToken.current = null;
                                setSubmitting(false);
                            }}
                        />
                    )}
                    <div css={tw`mt-6 text-center`}>
                        <Link to={'/auth/password'}>{t('auth.legacy_recovery')}</Link>
                    </div>
                    <div css={tw`mt-4 text-center`}>
                        <Link to={'/auth/login'}>{t('auth.legacy_back')}</Link>
                    </div>
                </LoginFormContainer>
            )}
        </Formik>
    );
};
