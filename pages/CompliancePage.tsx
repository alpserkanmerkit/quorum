import React, { useEffect, useState } from 'react';
import { CheckCircle, Plus, Search, Trash2 } from 'lucide-react';
import { ComplianceCheckResult, ComplianceSummaryResponse } from '../types';
import { fetchComplianceSummary } from '../services/runtime';
import { useNewsStore } from '../stores/newsStore';
import { useAuthStore } from '../stores/authStore';
import apiClient, { getApiErrorMessage } from '../utils/apiClient';
import '../styles/compliance.css';

const timeAgo = (timestamp: number) => {
    const delta = Math.floor((Date.now() - timestamp) / 1000);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    return `${Math.floor(delta / 3600)}h ago`;
};

function getFreshness(updatedAt: string): { label: string; tone: string } {
    const ageMs = Date.now() - Date.parse(updatedAt);

    if (ageMs <= 6 * 60 * 60 * 1000) {
        return { label: 'Fresh', tone: 'cp-tag--bull' };
    }

    if (ageMs <= 24 * 60 * 60 * 1000) {
        return { label: 'Aging', tone: 'cp-tag--warn' };
    }

    return { label: 'Review Needed', tone: 'cp-tag--neutral' };
}

const CompliancePage: React.FC = () => {
    const [summary, setSummary] = useState<ComplianceSummaryResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [mutationError, setMutationError] = useState<string | null>(null);
    const [mutationNotice, setMutationNotice] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [checkTicker, setCheckTicker] = useState('');
    const [checkResult, setCheckResult] = useState<ComplianceCheckResult | null>(null);
    const [newTicker, setNewTicker] = useState('');
    const [newName, setNewName] = useState('');
    const [newReason, setNewReason] = useState('');
    const runtimeView = useNewsStore((state) => state.runtimeView);
    const currentUser = useAuthStore((state) => state.user);

    useEffect(() => {
        let alive = true;

        (async () => {
            const result = await fetchComplianceSummary();
            if (!alive) return;
            setSummary(result);
            setLoading(false);
        })();

        return () => {
            alive = false;
        };
    }, []);

    const unresolvedAlerts = summary?.alerts.filter((alert) => !alert.resolved) ?? [];
    const pendingApprovals = summary?.pendingApprovals ?? [];
    const freshness = summary ? getFreshness(summary.updatedAt) : null;
    const canMutate = Boolean(summary);
    const canReview = currentUser?.role === 'ADMIN' || currentUser?.role === 'COMPLIANCE_OFFICER';

    const applySummary = (nextSummary: ComplianceSummaryResponse) => {
        setSummary(nextSummary);
        setMutationError(null);
    };

    const resolveAlert = async (alertId: string) => {
        setActionLoading(alertId);
        setMutationError(null);
        try {
            const response = await apiClient.post(`/api/compliance/alerts/${alertId}/resolve`);
            applySummary(response.data.summary);
            setMutationNotice('Compliance alert resolved and audited.');
        } catch (error) {
            setMutationError(getApiErrorMessage(error, 'Could not resolve compliance alert.'));
        } finally {
            setActionLoading(null);
        }
    };

    const removeRestricted = async (ticker: string) => {
        setActionLoading(`remove-${ticker}`);
        setMutationError(null);
        try {
            const response = await apiClient.delete(`/api/compliance/restricted/${ticker}`);
            applySummary(response.data.summary);
            setMutationNotice(`${ticker} removal is pending second approval.`);
        } catch (error) {
            setMutationError(getApiErrorMessage(error, 'Could not remove restricted security.'));
        } finally {
            setActionLoading(null);
        }
    };

    const addRestricted = async (event: React.FormEvent) => {
        event.preventDefault();
        setActionLoading('add-restricted');
        setMutationError(null);
        try {
            const response = await apiClient.post('/api/compliance/restricted', {
                ticker: newTicker,
                name: newName,
                reason: newReason,
            });
            applySummary(response.data.summary);
            setMutationNotice(`${newTicker.toUpperCase()} restriction is pending second approval.`);
            setNewTicker('');
            setNewName('');
            setNewReason('');
        } catch (error) {
            setMutationError(getApiErrorMessage(error, 'Could not add restricted security.'));
        } finally {
            setActionLoading(null);
        }
    };

    const reviewChange = async (changeId: string, decision: 'approve' | 'reject') => {
        setActionLoading(`${decision}-${changeId}`);
        setMutationError(null);
        setMutationNotice(null);
        try {
            const response = await apiClient.post(`/api/compliance/approvals/${changeId}/${decision}`, {});
            applySummary(response.data.summary);
            setMutationNotice(`Compliance change request ${decision === 'approve' ? 'approved' : 'rejected'}.`);
        } catch (error) {
            setMutationError(getApiErrorMessage(error, `Could not ${decision} compliance change request.`));
        } finally {
            setActionLoading(null);
        }
    };

    const runTickerCheck = async (event: React.FormEvent) => {
        event.preventDefault();
        setActionLoading('check-ticker');
        setMutationError(null);
        try {
            const response = await apiClient.post('/api/compliance/check', { ticker: checkTicker });
            setCheckResult(response.data.result);
        } catch (error) {
            setMutationError(getApiErrorMessage(error, 'Could not check ticker.'));
        } finally {
            setActionLoading(null);
        }
    };

    return (
        <div className="cp-page">
            <header className="q-page-header cp-header">
                <div>
                    <h2 className="q-page-title cp-title">Compliance Centre</h2>
                    <p className="q-page-sub cp-sub">Audit trail · Restricted list · Active alerts · Operational dataset</p>
                </div>
                <div className="cp-header-actions">
                    {freshness && (
                        <span className={`cp-header-note ${freshness.tone}`}>
                            {freshness.label}
                        </span>
                    )}
                    {unresolvedAlerts.length > 0 && (
                        <span className="cp-header-note cp-header-note--count">
                            {unresolvedAlerts.length} UNRESOLVED
                        </span>
                    )}
                </div>
            </header>

            <div className="cp-scroll">
                <div className="cp-body">
                    {!loading && !summary && (
                        <div className="cp-notice cp-notice--error" role="alert">
                            <span className="cp-notice__tag">Unavailable</span>
                            <p className="cp-notice__text">
                                Compliance dataset is temporarily unavailable. AI enforcement stays paused until backend coverage is restored.
                            </p>
                        </div>
                    )}

                    {summary && (
                        <div className="cp-facts">
                            <div className="cp-fact">
                                <p className="cp-label">Dataset Status</p>
                                <p data-testid="compliance-dataset-status" className="cp-value">{runtimeView.labels.compliance}</p>
                            </div>
                            <div className="cp-fact">
                                <p className="cp-label">Version</p>
                                <p data-testid="compliance-version" className="cp-value">v{summary.version}</p>
                            </div>
                            <div className="cp-fact">
                                <p className="cp-label">Updated</p>
                                <p data-testid="compliance-updated" className="cp-value">{new Date(summary.updatedAt).toLocaleString()}</p>
                            </div>
                            <div className="cp-fact cp-fact--wide">
                                <p className="cp-label">Snapshot Hash</p>
                                <p data-testid="compliance-hash" className="cp-value cp-value--hash">{summary.hash}</p>
                            </div>
                            <div className="cp-fact">
                                <p className="cp-label">Freshness</p>
                                <p data-testid="compliance-freshness" className={`cp-value ${freshness?.tone ?? ''}`}>{freshness?.label ?? 'Unknown'}</p>
                            </div>
                        </div>
                    )}

                    <section className="cp-section">
                        <h3 className="cp-section-title">COMPLIANCE ALERTS</h3>
                        {loading && <p className="cp-empty">Loading compliance alerts...</p>}
                        <ul className="cp-alerts">
                            {summary?.alerts.map((alert) => (
                                <li
                                    key={alert.id}
                                    className={`cp-alert ${alert.severity === 'CRITICAL' ? 'cp-alert--critical' : 'cp-alert--warning'}${alert.resolved ? ' cp-alert--resolved' : ''}`}
                                >
                                    <span className="cp-alert__level">{alert.severity}</span>
                                    <div className="cp-alert__body">
                                        <p className="cp-alert__msg">{alert.message}</p>
                                        <span className="cp-alert__kind">{alert.type.replace(/_/g, ' ')}</span>
                                    </div>
                                    <span className="cp-alert__time">{timeAgo(alert.timestamp)}</span>
                                    {alert.resolved ? (
                                        <span className="cp-resolved">
                                            <span aria-hidden="true">✓ </span>RESOLVED
                                        </span>
                                    ) : (
                                        <button type="button" className="cp-btn cp-btn--sm" disabled={actionLoading === alert.id} onClick={() => void resolveAlert(alert.id)}>
                                            <CheckCircle size={12} aria-hidden="true" /> Resolve
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>

                    <div className="cp-columns">
                        <div className="cp-main">
                            <section className="cp-section">
                                <h3 className="cp-section-title">RESTRICTED SECURITIES LIST</h3>
                                <p className="cp-deck">
                                    Source of truth is the backend compliance ledger. Restricted-list changes are audited and require second approval.
                                </p>
                                <div className="cp-table-wrap">
                                    <table className="cp-table">
                                        <thead>
                                            <tr>
                                                <th>TICKER</th>
                                                <th>NAME</th>
                                                <th>REASON</th>
                                                <th className="cp-num">RESTRICTED SINCE</th>
                                                <th className="cp-num">EXPIRES</th>
                                                <th>ADDED BY</th>
                                                <th>ACTION</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {summary?.restricted.map((security) => (
                                                <tr key={security.ticker}>
                                                    <td className="cp-ticker">{security.ticker}</td>
                                                    <td>{security.name}</td>
                                                    <td className="cp-dim">{security.reason}</td>
                                                    <td className="cp-num">{new Date(security.restrictedSince).toLocaleDateString()}</td>
                                                    <td className="cp-num">
                                                        {security.restrictedUntil ? new Date(security.restrictedUntil).toLocaleDateString() : 'Open'}
                                                    </td>
                                                    <td>{security.addedBy}</td>
                                                    <td>
                                                        <button type="button" className="cp-btn cp-btn--sm" disabled={actionLoading === `remove-${security.ticker}`} onClick={() => void removeRestricted(security.ticker)}>
                                                            <Trash2 size={12} aria-hidden="true" /> Remove
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </section>

                            <section className="cp-section" data-signature="corrections">
                                <h3 className="cp-section-title">AUDIT TRAIL</h3>
                                <h4 className="cp-kicker">Corrections &amp; clarifications</h4>
                                {summary && summary.audit.length === 0 && (
                                    <p className="cp-empty">No audit entries on record.</p>
                                )}
                                <ol className="cp-notes">
                                    {summary?.audit.map((entry) => (
                                        <li key={entry.id} className="cp-note">
                                            <span className="cp-note__time" title={new Date(entry.timestamp).toLocaleString()}>{timeAgo(entry.timestamp)}</span>
                                            <span className="cp-note__who">{entry.userName}</span>
                                            <div className="cp-note__main">
                                                <h5 className="cp-note__title">{entry.action}</h5>
                                                <p className="cp-note__body">{entry.details}</p>
                                                <span className="cp-note__cat">{entry.category.replace(/_/g, ' ')}</span>
                                            </div>
                                        </li>
                                    ))}
                                </ol>
                            </section>
                        </div>

                        <aside className="cp-side" aria-label="Compliance actions">
                            <section data-testid="compliance-actions" className="cp-section">
                                <h3 className="cp-section-title">COMPLIANCE ACTIONS</h3>
                                {mutationError && (
                                    <div className="cp-notice cp-notice--error" role="alert">
                                        <span className="cp-notice__tag">Error</span>
                                        <span>{mutationError}</span>
                                    </div>
                                )}
                                {mutationNotice && (
                                    <div className="cp-notice cp-notice--ok" role="status">
                                        <span className="cp-notice__tag">Done</span>
                                        <span>{mutationNotice}</span>
                                    </div>
                                )}
                                <form onSubmit={runTickerCheck} className="cp-form">
                                    <p className="cp-label cp-form__title">Restricted Ticker Check</p>
                                    <div className="cp-check-row">
                                        <input className="cp-input cp-input--upper" aria-label="Ticker to check" value={checkTicker} onChange={(event) => setCheckTicker(event.target.value.toUpperCase())} placeholder="AAPL" disabled={!canMutate} />
                                        <button className="cp-btn cp-btn--tall" disabled={!canMutate || !checkTicker.trim() || actionLoading === 'check-ticker'} type="submit">
                                            <Search size={13} aria-hidden="true" /> Check
                                        </button>
                                    </div>
                                    {checkResult && (
                                        <div className={`cp-notice cp-notice--flush ${checkResult.restricted ? 'cp-notice--error' : 'cp-notice--ok'}`} role="status">
                                            <span className="cp-notice__tag">{checkResult.restricted ? '▲ Restricted' : '✓ Clear'}</span>
                                            <span>{checkResult.ticker} is {checkResult.restricted ? `restricted: ${checkResult.security?.reason}` : 'clear for review'}.</span>
                                        </div>
                                    )}
                                </form>

                                <form onSubmit={addRestricted} className="cp-form">
                                    <p className="cp-label cp-form__title">Add to restricted list</p>
                                    <label className="cp-field">
                                        <span className="cp-label">TICKER</span>
                                        <input className="cp-input cp-input--upper" value={newTicker} onChange={(event) => setNewTicker(event.target.value.toUpperCase())} disabled={!canMutate} required />
                                    </label>
                                    <label className="cp-field">
                                        <span className="cp-label">NAME</span>
                                        <input className="cp-input" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={!canMutate} required />
                                    </label>
                                    <label className="cp-field">
                                        <span className="cp-label">REASON</span>
                                        <input className="cp-input" value={newReason} onChange={(event) => setNewReason(event.target.value)} disabled={!canMutate} required />
                                    </label>
                                    <button className="cp-btn cp-btn--primary cp-btn--tall cp-form__submit" type="submit" disabled={!canMutate || actionLoading === 'add-restricted'}>
                                        <Plus size={13} aria-hidden="true" /> Add
                                    </button>
                                </form>
                            </section>

                            <section data-testid="compliance-pending-approvals" className="cp-section">
                                <h3 className="cp-section-title">PENDING APPROVALS</h3>
                                <p className="cp-deck">
                                    Restricted-list changes require a second compliance/admin reviewer before they affect enforcement.
                                </p>
                                {pendingApprovals.length === 0 ? (
                                    <p className="cp-empty">No pending compliance change requests.</p>
                                ) : (
                                    <div className="cp-table-wrap">
                                        <table className="cp-table">
                                            <thead>
                                                <tr>
                                                    <th>ACTION</th>
                                                    <th>TICKER</th>
                                                    <th>REQUESTED BY</th>
                                                    <th>REASON</th>
                                                    <th className="cp-num">TIME</th>
                                                    <th>REVIEW</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {pendingApprovals.map((change) => {
                                                    const isOwnRequest = currentUser?.id === change.requestedById;
                                                    return (
                                                        <tr key={change.id}>
                                                            <td>
                                                                <span className={`cp-tag ${change.action === 'ADD_RESTRICTED' ? 'cp-tag--warn' : 'cp-tag--neutral'}`}>
                                                                    {change.action.replace(/_/g, ' ')}
                                                                </span>
                                                            </td>
                                                            <td className="cp-ticker">{change.ticker}</td>
                                                            <td>{change.requestedByName}</td>
                                                            <td className="cp-dim">{change.reason ?? 'No reason supplied'}</td>
                                                            <td className="cp-num">{timeAgo(change.createdAt)}</td>
                                                            <td>
                                                                <div className="cp-row-actions">
                                                                    <button type="button" className="cp-btn cp-btn--sm cp-btn--primary" disabled={!canReview || isOwnRequest || actionLoading === `approve-${change.id}`} onClick={() => void reviewChange(change.id, 'approve')}>
                                                                        Approve
                                                                    </button>
                                                                    <button type="button" className="cp-btn cp-btn--sm" disabled={!canReview || isOwnRequest || actionLoading === `reject-${change.id}`} onClick={() => void reviewChange(change.id, 'reject')}>
                                                                        Reject
                                                                    </button>
                                                                </div>
                                                                {isOwnRequest && (
                                                                    <p className="cp-hint">Second reviewer required</p>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </section>
                        </aside>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CompliancePage;
