import React from 'react';
import { Route, Switch, useRouteMatch } from 'react-router-dom';
import LoginContainer from '@/components/auth/LoginContainer';
import LegacyLoginContainer from '@/components/auth/LegacyLoginContainer';
import { Redirect } from 'react-router-dom';
import { useStoreState } from '@/state/hooks';
import ForgotPasswordContainer from '@/components/auth/ForgotPasswordContainer';
import ResetPasswordContainer from '@/components/auth/ResetPasswordContainer';
import LoginCheckpointContainer from '@/components/auth/LoginCheckpointContainer';
import { NotFound } from '@/components/elements/ScreenBlock';
import { useHistory, useLocation } from 'react-router';

export default () => {
    const history = useHistory();
    const location = useLocation();
    const { path } = useRouteMatch();
    const localAuthEnabled = useStoreState((state) => state.settings.data?.localAuthEnabled ?? false);

    return (
        <div className={'pt-8 xl:pt-32'}>
            <Switch location={location}>
                <Route path={`${path}/login`} component={LoginContainer} exact />
                <Route path={`${path}/login/legacy`} exact>
                    {localAuthEnabled ? <LegacyLoginContainer /> : <Redirect to={'/auth/login'} />}
                </Route>
                <Route path={`${path}/login/checkpoint`} component={LoginCheckpointContainer} />
                <Route path={`${path}/password`} exact>
                    {localAuthEnabled ? <ForgotPasswordContainer /> : <Redirect to={'/auth/login'} />}
                </Route>
                <Route path={`${path}/password/reset/:token`} render={(props) =>
                    localAuthEnabled ? <ResetPasswordContainer {...props} /> : <Redirect to={'/auth/login'} />
                } />
                <Route path={`${path}/checkpoint`} />
                <Route path={'*'}>
                    <NotFound onBack={() => history.push('/auth/login')} />
                </Route>
            </Switch>
        </div>
    );
};
