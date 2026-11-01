import React, { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import apiClient, { getApiErrorMessage } from '../../utils/apiClient';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../../shared/demoAccount';
import { BRAND } from '../../shared/brand';
import '../../styles/compliance.css';

// `npm run demo` starts Vite with VITE_DEMO_MODE=1: the UI signs in automatically with the public demo account.
const IS_DEMO_UI = import.meta.env.VITE_DEMO_MODE === '1';

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const setAuth = useAuthStore((state) => state.setAuth);
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState(IS_DEMO_UI ? DEMO_EMAIL : '');
    const [password, setPassword] = useState(IS_DEMO_UI ? DEMO_PASSWORD : '');
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (isAuthenticated) return;
        try {
            const stored = window.sessionStorage.getItem('quorum-auth');
            const parsed = stored ? JSON.parse(stored) : null;
            const state = parsed?.state;
            if (state?.isAuthenticated && state.token && state.user) {
                setAuth(state.token, state.user);
            }
        } catch {
            // Invalid persisted auth should fall through to the login form.
        }
    }, [isAuthenticated, setAuth]);

    useEffect(() => {
        if (!IS_DEMO_UI || isAuthenticated) return;
        let cancelled = false;
        apiClient.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD })
            .then((response) => {
                if (!cancelled && response.data.success) setAuth(response.data.token, response.data.user);
            })
            .catch(() => {
                // If auto-login fails, the form stays open, prefilled with the demo credentials.
            });
        return () => {
            cancelled = true;
        };
    }, [isAuthenticated, setAuth]);

    if (isAuthenticated) {
        return <>{children}</>;
    }

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');
        setIsLoading(true);

        try {
            if (!isLogin) {
                // The register response is uniform (account enumeration guard) and carries no token; sign in with the same credentials.
                await apiClient.post('/api/auth/register', { email, password, name });
            }
            const response = await apiClient.post('/api/auth/login', { email, password });
            if (response.data.success) {
                setAuth(response.data.token, response.data.user);
            }
        } catch (submitError) {
            setError(getApiErrorMessage(submitError, 'Authentication failed. Access denied.'));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <main className="ag-root">
            <div className="ag-sheet">
                <header className="ag-masthead">
                    <h1 className="ag-wordmark">{BRAND.name}</h1>
                    <p className="ag-tagline">{BRAND.tagline} · {BRAND.edition}</p>
                </header>

                <p className="ag-prompt">{isLogin ? 'Sign in to continue.' : 'Create an account to continue.'}</p>
                {error && (
                    <div className="ag-error" role="alert">
                        <span className="ag-error__tag">Error</span>
                        <span>{error}</span>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="ag-form">
                    {!isLogin && (
                        <label className="ag-field">
                            <span className="ag-label">Name</span>
                            <input className="ag-input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required={!isLogin} />
                        </label>
                    )}
                    <label className="ag-field">
                        <span className="ag-label">Email</span>
                        <input className="ag-input" value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
                    </label>
                    <label className="ag-field">
                        <span className="ag-label">Password</span>
                        <input className="ag-input" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={isLogin ? 'current-password' : 'new-password'} required />
                    </label>

                    <button type="submit" className="ag-btn ag-btn--primary" disabled={isLoading}>
                        {isLoading ? 'Processing...' : isLogin ? 'Sign in' : 'Create account'}
                    </button>
                </form>

                <p className="ag-switch">
                    {isLogin ? 'No account?' : 'Already registered?'}{' '}
                    <button type="button" className="ag-link" onClick={() => setIsLogin((value) => !value)}>
                        {isLogin ? 'Request access' : 'Sign in'}
                    </button>
                </p>
            </div>
        </main>
    );
};
