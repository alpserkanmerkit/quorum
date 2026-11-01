import React, { useState } from 'react';
import { DataMode, NewsItem, Sentiment, TradingScenario } from '../types';
import ScoreBadge from './ScoreBadge';
import { ChevronDown, ChevronUp, Activity, Share2, Globe, FileText, Loader2, TrendingUp, TrendingDown, Shield, AlertOctagon } from 'lucide-react';
import apiClient, { getApiErrorMessage } from '../utils/apiClient';
import { ExportProgressToast } from './ui/ExportProgressToast';
import '../styles/dashboard.css';

export type NewsCardVariant = 'lead' | 'column';

interface NewsCardProps {
  item: NewsItem;
  onAnalyze?: () => void;
  onGenerateDeepDive: (id: string) => void;
  /** 'lead' = the top scored story (larger headline); 'column' = a standard story row. */
  variant?: NewsCardVariant;
}

const sentimentClass = (sentiment?: Sentiment): string => {
  if (sentiment === Sentiment.POSITIVE) return 'qd-sentiment qd-sentiment--up';
  if (sentiment === Sentiment.NEGATIVE) return 'qd-sentiment qd-sentiment--down';
  return 'qd-sentiment';
};

const directionClass = (direction: string): string => {
  switch (direction) {
    case 'LONG':
      return 'qd-direction qd-direction--long';
    case 'SHORT':
      return 'qd-direction qd-direction--short';
    case 'HEDGE':
      return 'qd-direction qd-direction--hedge';
    default:
      return 'qd-direction';
  }
};

const getDirectionIcon = (direction: string) => {
  switch (direction) {
    case 'LONG':
      return <TrendingUp size={16} />;
    case 'SHORT':
      return <TrendingDown size={16} />;
    case 'HEDGE':
      return <Shield size={16} />;
    default:
      return <Activity size={16} />;
  }
};

const riskClass = (risk: string): string => {
  switch (risk) {
    case 'LOW':
      return 'qd-risk qd-risk--low';
    case 'MEDIUM':
      return 'qd-risk qd-risk--medium';
    case 'HIGH':
      return 'qd-risk qd-risk--high';
    default:
      return 'qd-risk';
  }
};

const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Provenance wording for an assessed story; unknown modes are stated, not guessed. */
const modeLabel = (mode?: DataMode): string => {
  if (mode === 'live') return 'AI live';
  if (mode === 'simulation') return 'AI simulation';
  if (mode === 'fallback') return 'AI fallback';
  return 'AI mode not reported';
};

const NewsCard: React.FC<NewsCardProps> = ({ item, onAnalyze, onGenerateDeepDive, variant = 'column' }) => {
  const [expanded, setExpanded] = useState(false);
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const isLead = variant === 'lead';

  const handleExport = async () => {
    setExportError(null);
    try {
      const response = await apiClient.post('/api/export/generate-pdf', {
        reportData: {
          headline: item.headline,
          score: item.score,
          summary: item.summary,
          deepDive: item.deepDive,
        },
      });
      if (response.data.success) {
        setExportJobId(response.data.jobId);
      }
    } catch (error) {
      setExportError(getApiErrorMessage(error, 'Export queue is unavailable.'));
    }
  };

  const cardClass = [
    'qd-card',
    isLead ? 'qd-card--lead' : 'qd-card--column',
    expanded ? 'qd-card--expanded' : '',
  ].filter(Boolean).join(' ');

  const renderScoreSlot = () => {
    if (item.isAnalysing) {
      return <div className="qd-status qd-status--busy qd-spin" aria-hidden="true" />;
    }
    if (item.isAnalyzed && item.score !== undefined) {
      return (
        <span className="qd-score">
          <span className="qd-score__label">Signal score</span>
          <ScoreBadge score={item.score} size={isLead ? 'lg' : 'md'} />
        </span>
      );
    }
    if (item.analysisError) {
      return <div className="qd-status qd-status--retry">Retry</div>;
    }
    if (item.analysisQueued) {
      return <div className="qd-status qd-status--queued">Queued</div>;
    }
    return <div className="qd-status">Pending</div>;
  };

  const tickers = (item.affectedAssets && item.affectedAssets.length > 0 ? item.affectedAssets : item.relatedTickers) ?? [];
  // Rationale is shown only when the item carries one; the summary stays in the expanded quick take.
  const rationale = item.isAnalyzed ? item.scoreRationale : undefined;

  return (
    <article className={cardClass} data-variant={variant}>
      <div className="qd-card__body">
        <div className="qd-touches">
          <span className="qd-field-label">Touches</span>
          {tickers.length > 0 ? (
            <div className="qd-tickers">
              {tickers.map((asset) => (
                <span key={asset} className="qd-tag">${asset}</span>
              ))}
            </div>
          ) : (
            <span className="qd-muted">No tickers named</span>
          )}
        </div>

        <div className="qd-main">
          <h3 className="qd-headline" onClick={() => setExpanded(!expanded)}>
            {item.headline}
          </h3>

          {rationale && (
            <p className={`qd-rationale${expanded ? '' : ' qd-rationale--clamped'}`}>{rationale}</p>
          )}

          <p className="qd-provenance">
            <span>Source: {item.source}</span>
            <span>
              {item.sourceReliability !== undefined ? `Reliability ${item.sourceReliability}/100` : 'Reliability not rated'}
            </span>
            <span>{item.category}</span>
            <span className={item.isAnalyzed ? `qd-mode qd-mode--${item.analysisMode ?? 'unknown'}` : 'qd-mode'}>
              {item.isAnalyzed ? modeLabel(item.analysisMode) : 'Not yet scored'}
            </span>
            <span>as of {formatTime(item.timestamp)}</span>
          </p>

          {!item.isAnalyzed && onAnalyze && (
            <button
              onClick={onAnalyze}
              disabled={item.isAnalysing}
              className="q-btn q-btn--ghost q-btn--sm qd-analyze"
            >
              {item.isAnalysing ? <Loader2 size={13} className="qd-spin" /> : <Activity size={13} />}
              {item.isAnalysing ? 'Analyzing' : item.analysisQueued ? 'Queued' : item.analysisError ? 'Retry Analyze' : 'Analyze'}
            </button>
          )}

          {!item.isAnalyzed && (item.analysisNotice || item.analysisError) && (
            <div className={`qd-notice${item.analysisError ? ' qd-notice--error' : ''}`}>
              {item.analysisNotice ?? item.analysisError}
            </div>
          )}
        </div>

        <div className="qd-card__side">
          <div className="qd-assess">
            {item.isAnalyzed && <span className={sentimentClass(item.sentiment)}>{item.sentiment}</span>}
            {renderScoreSlot()}
          </div>
          <button
            className="qd-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse story' : 'Expand story'}
          >
            {expanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </button>
        </div>
      </div>

      {expanded && item.isAnalyzed && (
        <div className="qd-expanded">
          <div className="qd-take">
            <div className="qd-label qd-take__label">
              <Globe size={12} />
              Quorum Quick Take
            </div>
            <p className="qd-take__text">{item.summary}</p>
          </div>

          <div>
            {!item.deepDive ? (
              <button
                onClick={() => onGenerateDeepDive(item.id)}
                disabled={item.isDeepDiveLoading}
                className="qd-deepdive-cta"
              >
                <div className="qd-deepdive-cta__row">
                  <div className="qd-deepdive-cta__lead">
                    <div className="qd-deepdive-cta__icon">
                      {item.isDeepDiveLoading ? <Loader2 size={20} className="qd-spin" /> : <FileText size={20} />}
                    </div>
                    <div>
                      <h4 className="qd-deepdive-cta__title">
                        {item.isDeepDiveLoading ? 'Generating Analysis & Scenarios...' : 'Generate Deep Dive & Decision-Support Scenarios'}
                      </h4>
                      <p className="qd-deepdive-cta__sub">
                        {item.isDeepDiveLoading ? 'Calculating correlations...' : 'Get a 270-word report with paper/simulation setups'}
                      </p>
                    </div>
                  </div>
                  {!item.isDeepDiveLoading && <span className="qd-pro">PRO FEATURE</span>}
                </div>
              </button>
            ) : (
              <div className="qd-dive">
                <div className="qd-dive__head">
                  <span className="qd-label qd-dive__title">
                    <FileText size={12} /> Deep Dive Protocol
                  </span>
                  <span className="qd-label qd-dive__stamp">
                    270 WORDS | AI-GENERATED
                    {item.groundingUsed && <span className="qd-grounded">GROUNDED</span>}
                    {item.deepDiveMode && item.deepDiveMode !== 'live' && (
                      <span className={item.deepDiveMode === 'simulation' ? 'qd-dive__mode qd-dive__mode--warn' : 'qd-dive__mode qd-dive__mode--bear'}>
                        {item.deepDiveMode.toUpperCase()}
                      </span>
                    )}
                  </span>
                </div>

                <div className="qd-dive__text">
                  {item.deepDiveNotice && (
                    <div className="qd-notice qd-notice--flush">
                      {item.deepDiveNotice}
                    </div>
                  )}
                  {item.deepDive.content.split('**').map((part, index) => {
                    if (index % 2 === 1) {
                      return (
                        <span key={index} className="qd-label qd-dive__section">
                          {part}
                        </span>
                      );
                    }

                    return <span key={index}>{part}</span>;
                  })}

                  {item.groundingUsed && item.groundingSources && item.groundingSources.length > 0 && (
                    <div className="qd-sources">
                      <h5 className="qd-label qd-sources__title">
                        <Globe size={12} />
                        Real-Time Verified Sources
                      </h5>
                      <ul className="qd-sources__list">
                        {item.groundingSources.map((source, index) => (
                          <li key={index} className="qd-sources__item">
                            <a href={source.uri} target="_blank" rel="noreferrer" className="qd-sources__link">
                              {source.title || source.uri}
                            </a>
                            <span className="qd-sources__host">
                              {new URL(source.uri).hostname}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <div className="qd-dive__body">
                  <div className="qd-disclaimer">
                    <AlertOctagon size={16} className="qd-disclaimer__icon" />
                    <p className="qd-disclaimer__text">
                      <strong>DISCLAIMER: NOT INVESTMENT ADVICE</strong>
                      The following scenarios are AI-generated probability models based on historical correlations. They do not account for your personal financial situation. Capital at risk.
                    </p>
                  </div>

                  <h4 className="qd-label qd-positions-title">
                    <Activity size={16} />
                    STRATEGIC POSITIONS
                  </h4>

                  <div className="qd-scenarios">
                    {item.deepDive.scenarios.map((scenario: TradingScenario, index: number) => (
                      <div key={index} className="qd-scenario">
                        <div className={directionClass(scenario.direction)}>
                          {getDirectionIcon(scenario.direction)}
                          {scenario.direction}
                        </div>
                        <div className="qd-scenario__main">
                          <div className="qd-scenario__head">
                            <span className="qd-scenario__asset">{scenario.asset}</span>
                            <span className={riskClass(scenario.risk)}>RISK: {scenario.risk}</span>
                          </div>
                          <p className="qd-scenario__why">{scenario.rationale}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="qd-fineprint">
                    System generated decision-support content. Paper/simulation scenarios are not investment advice.
                  </p>
                </div>

                <div className="qd-dive__foot">
                  <button onClick={handleExport} className="qd-linkbtn">
                    <Share2 size={12} /> Export PDF
                  </button>
                </div>
                {exportError && <div className="qd-export-error">{exportError}</div>}
              </div>
            )}
          </div>
        </div>
      )}
      {exportJobId && <ExportProgressToast jobId={exportJobId} onClose={() => setExportJobId(null)} />}
    </article>
  );
};

export default NewsCard;
