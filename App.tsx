import React, { Suspense, lazy, useContext, useEffect, useLayoutEffect, useMemo } from 'react';
import { BrowserRouter, Routes, Route, Navigate, UNSAFE_NavigationContext, useLocation } from 'react-router-dom';
import type { Navigator } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import TopBar from './components/TopBar';
import StatusBar from './components/StatusBar';
import DashboardPage from './pages/DashboardPage';
import { useNewsStore } from './stores/newsStore';
import { AuthGate } from './components/auth/AuthGate';
import { NEWS_QUERY_KEY } from './hooks/queries/useNewsQueries';

const PortfolioPage = lazy(() => import('./pages/PortfolioPage'));
const WarRoomPage = lazy(() => import('./pages/WarRoomPage'));
const CompliancePage = lazy(() => import('./pages/CompliancePage'));
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 60 * 1000,
    },
  },
});

const RouteFallback: React.FC = () => (
  <div className="q-route-fallback">
    <div className="q-card q-route-fallback__card" role="status">
      Loading module...
    </div>
  </div>
);

// Route transitions: link navigations (history push) run inside document.startViewTransition so the
// outgoing and incoming page cross-fade (160-200 ms, opacity/transform only, see index.css).
// Without the API, or with prefers-reduced-motion, navigation is the plain, unanimated push.
const VIEW_TRANSITION_SETTLE_MS = 1000;
let settlePendingTransition: (() => void) | null = null;

const ViewTransitionNavigation: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigation = useContext(UNSAFE_NavigationContext);
  const location = useLocation();

  // The router commits the new location in a React transition; the browser may take its
  // "after" snapshot only once that commit is on screen.
  useLayoutEffect(() => {
    settlePendingTransition?.();
  }, [location]);

  const navigator = useMemo<Navigator>(() => {
    const base = navigation.navigator;
    const push: Navigator['push'] = (to, state, opts) => {
      const canAnimate =
        typeof document.startViewTransition === 'function' &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!canAnimate) {
        base.push(to, state, opts);
        return;
      }
      settlePendingTransition?.();
      const transition = document.startViewTransition(
        () =>
          new Promise<void>((resolve) => {
            const timer = window.setTimeout(settle, VIEW_TRANSITION_SETTLE_MS);
            function settle() {
              window.clearTimeout(timer);
              if (settlePendingTransition === settle) settlePendingTransition = null;
              resolve();
            }
            settlePendingTransition = settle;
            base.push(to, state, opts);
          }),
      );
      // A skipped transition rejects these promises; navigation itself has already happened.
      const ignore = () => undefined;
      transition.ready.catch(ignore);
      transition.finished.catch(ignore);
      transition.updateCallbackDone.catch(ignore);
    };
    return Object.create(base, { push: { value: push } }) as Navigator;
  }, [navigation.navigator]);

  const value = useMemo(() => ({ ...navigation, navigator }), [navigation, navigator]);
  return <UNSAFE_NavigationContext.Provider value={value}>{children}</UNSAFE_NavigationContext.Provider>;
};

const AppContent: React.FC = () => {
  const { isStreamActive, refreshRuntimeStatus } = useNewsStore();
  const activeQueryClient = useQueryClient();

  useEffect(() => {
    void refreshRuntimeStatus();
  }, [refreshRuntimeStatus]);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    if (isStreamActive && import.meta.env.VITE_API_BASE_URL) {
      eventSource = new EventSource(`${import.meta.env.VITE_API_BASE_URL}/api/news/stream`);
      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'update') {
          void activeQueryClient.invalidateQueries({ queryKey: NEWS_QUERY_KEY });
        }
      };
    }
    return () => {
      eventSource?.close();
    };
  }, [activeQueryClient, isStreamActive]);

  useEffect(() => {
    const refresh = () => {
      void refreshRuntimeStatus();
    };

    const runtimeInterval = setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);

    return () => {
      clearInterval(runtimeInterval);
      window.removeEventListener('focus', refresh);
    };
  }, [refreshRuntimeStatus]);

  return (
    <ViewTransitionNavigation>
      <div className="q-shell">
        <TopBar />
        <div className="q-main">
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/portfolio" element={<PortfolioPage />} />
              <Route path="/war-room" element={<WarRoomPage />} />
              <Route path="/compliance" element={<CompliancePage />} />
            </Routes>
          </Suspense>
        </div>
        <StatusBar />
      </div>
    </ViewTransitionNavigation>
  );
};

const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <AuthGate>
        <AppContent />
      </AuthGate>
    </BrowserRouter>
    <ReactQueryDevtools initialIsOpen={false} />
  </QueryClientProvider>
);

export default App;
