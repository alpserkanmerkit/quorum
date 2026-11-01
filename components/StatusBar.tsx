import React from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import { useNewsStore } from '../stores/newsStore';

// Desk v2 shell: one thin status line under every page (feed state, runtime, service badges).
const BADGE_TONE: Record<'ready' | 'limited' | 'offline', string> = {
  ready: 'q-badge--bull',
  limited: 'q-badge--warn',
  offline: 'q-badge--neutral',
};

const CURRENT_USER = { name: 'Demo Fund Manager', tier: 'Institutional' };

const StatusBar: React.FC = () => {
  const { isStreamActive, runtimeView } = useNewsStore();
  const statusBadges: Array<{ label: string; value: string; tone: 'ready' | 'limited' | 'offline' }> = [
    { label: 'Backend', value: runtimeView.labels.backend, tone: runtimeView.backendLive ? 'ready' : 'offline' },
    { label: 'AI', value: runtimeView.labels.ai, tone: runtimeView.aiMode === 'live' ? 'ready' : 'limited' },
    { label: 'Feed', value: runtimeView.labels.feed, tone: runtimeView.feedMode === 'live' ? 'ready' : 'limited' },
    { label: 'Quant', value: runtimeView.labels.quant, tone: runtimeView.quantStatus === 'reachable' ? 'ready' : 'limited' },
    {
      label: 'Compliance',
      value: runtimeView.labels.compliance,
      tone: runtimeView.complianceStatus === 'ready' ? 'ready' : runtimeView.complianceStatus === 'degraded' ? 'limited' : 'offline',
    },
  ];

  return (
    <footer className="q-statusbar">
      <span className="q-statusbar__feed">
        <span className={`q-status-indicator ${isStreamActive ? 'q-status-indicator--live' : 'q-status-indicator--paused'}`} />
        {isStreamActive ? 'Live feed' : 'Paused'}
      </span>
      <span data-testid="runtime-status" className="q-status-runtime">
        {runtimeView.backendLive ? <Wifi size={12} /> : <WifiOff size={12} />}
        {runtimeView.backendLive ? 'Runtime Online' : 'Runtime Offline'}
      </span>
      <span className="q-status-badges">
        {statusBadges.map((badge) => (
          <span key={badge.label} data-testid={`runtime-badge-${badge.label.toLowerCase()}`} className={`q-badge ${BADGE_TONE[badge.tone]}`}>
            {badge.label}: {badge.value}
          </span>
        ))}
      </span>
      <span className="q-statusbar__user">{CURRENT_USER.name} · {CURRENT_USER.tier}</span>
    </footer>
  );
};

export default StatusBar;
