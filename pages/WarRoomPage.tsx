/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, Clock, ExternalLink, Globe, Send, BarChart2 } from 'lucide-react';
import { useAgentStore, AGENT_PERSONAS } from '../stores/agentStore';
import { useNewsStore } from '../stores/newsStore';
import { AgentArgument, ConsensusResult, DataMode, NewsItem } from '../types';
import { AiRouteReason } from '../services/gemini';
import { AI_RUNTIME_CONFIG } from '../shared/aiConfig';
import { useNews } from '../hooks/queries/useNewsQueries';
import apiClient, { apiFetch, getApiErrorMessage } from '../utils/apiClient';
import '../styles/warroom.css';

const DIRECTION_STYLE: Record<string, string> = {
    LONG: 'q-badge--bull',
    SHORT: 'q-badge--bear',
    HEDGE: 'q-badge--warn',
    WAIT: 'q-badge--neutral',
};

// Op-ed stance label for each trade position (presentation only).
const STANCE: Record<string, { label: string; tone: 'for' | 'against' | 'hedge' | 'abstain' }> = {
    LONG: { label: 'FOR', tone: 'for' },
    SHORT: { label: 'AGAINST', tone: 'against' },
    HEDGE: { label: 'HEDGE', tone: 'hedge' },
    WAIT: { label: 'ABSTAIN', tone: 'abstain' },
};

// Direction glyphs for the decision record: always paired with the text label (never colour alone).
const STANCE_MARK: Record<'for' | 'against' | 'hedge' | 'abstain' | 'pending', string> = {
    for: '▲',
    against: '▼',
    hedge: '◌',
    abstain: '◌',
    pending: '◌',
};

// Provenance wording for every filed view (presentation only; the mode itself comes from the debate run).
function provenanceLabel(mode: DataMode | null): string {
    if (mode === 'live') return 'Live';
    if (mode === 'simulation') return 'AI simulation';
    if (mode === 'fallback') return 'Local fallback';
    return 'Provenance pending';
}

// First sentence becomes the lead line of the rationale; the rest is the body.
function splitPullQuote(text: string): { quote: string; body: string } {
    const trimmed = text.trim();
    const match = trimmed.match(/^([\s\S]{12,220}?[.!?])\s+([\s\S]+)$/);
    if (match) return { quote: match[1], body: match[2] };
    return trimmed.length <= 220 ? { quote: trimmed, body: '' } : { quote: '', body: trimmed };
}

type AgentAnalysisFetchResult =
    | { status: 'success'; argument: AgentArgument; payload: any }
    | { status: 'error'; agentId: string; reason: AiRouteReason; notice: string; transportFailure: boolean };

export type DebateHorizon = 'short' | 'medium' | 'long';
type StrategyTicket = {
    ticker: string;
    side: 'BUY' | 'SELL';
    price?: number;
    source?: string;
    actionable: boolean;
};

type StrategyQuote = {
    symbol: string;
    price: number;
    source: string;
    updatedAt: number;
};

type TradeSetupPoint = { day: number; price: number };
type TradeSetupSource = 'QUANT' | 'FALLBACK' | 'HEURISTIC' | null;
type TradeSetupVariant = 'live' | 'fallback' | 'heuristic' | 'quote';
type QuantPreviewStatus = 'idle' | 'loading' | 'no_ticker' | 'ready' | 'fallback' | 'error';
type QuantPreviewResult =
    | { status: 'ready' | 'fallback'; data: any; reason?: string | null }
    | { status: 'no_ticker' | 'error'; data: null; reason?: string | null };
type QuantPreviewState = {
    status: QuantPreviewStatus;
    reason?: string | null;
};
type TradeSetupView = {
    ticker: string | null;
    entryPrice: number | null;
    targetPrice: number | null;
    targetSource: TradeSetupSource;
    graphData: TradeSetupPoint[];
    upperBand: number | null;
    lowerBand: number | null;
    priceTitle: string;
    bandText: string;
    sourceLabel: string;
    chartVariant: TradeSetupVariant;
    quantState: QuantPreviewStatus;
    notice: string | null;
};

function toFiniteNumber(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function toPositiveFiniteNumber(value: unknown): number | null {
    const numeric = toFiniteNumber(value);
    return numeric != null && numeric > 0 ? numeric : null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

export function deriveRepresentativePath(value: unknown): number[] {
    if (!Array.isArray(value) || value.length === 0) return [];

    if (value.every((point) => Number.isFinite(Number(point)))) {
        return value
            .map((point) => toPositiveFiniteNumber(point))
            .filter((point): point is number => point != null);
    }

    if (value.every((row) => Array.isArray(row))) {
        return value
            .map((row) => {
                const values = (row as unknown[])
                    .map((point) => toPositiveFiniteNumber(point))
                    .filter((point): point is number => point != null)
                    .sort((a, b) => a - b);
                if (values.length === 0) return null;
                const midpoint = Math.floor(values.length / 2);
                return values.length % 2 === 0
                    ? (values[midpoint - 1] + values[midpoint]) / 2
                    : values[midpoint];
            })
            .filter((point): point is number => point != null);
    }

    return [];
}

export function getHorizonDayCount(horizon: DebateHorizon): number {
    if (horizon === 'short') return 90;
    if (horizon === 'medium') return 180;
    return 1095;
}

export function buildAlignedProjectionPath(params: {
    entryPrice: number | null;
    targetPrice: number | null;
    rawPath: unknown;
    horizon: DebateHorizon;
}): TradeSetupPoint[] {
    const { entryPrice, targetPrice, rawPath, horizon } = params;
    if (!entryPrice || !targetPrice) return [];

    const representativePath = deriveRepresentativePath(rawPath);
    const path = representativePath.length > 1 ? representativePath : [entryPrice, targetPrice];
    const first = path[0];
    const last = path[path.length - 1];
    const maxDay = getHorizonDayCount(horizon);

    return path.map((price, index) => {
        const progress = path.length === 1 ? 1 : index / (path.length - 1);
        const anchoredPrice = price
            + ((entryPrice - first) * (1 - progress))
            + ((targetPrice - last) * progress);
        return {
            day: Math.round(progress * maxDay),
            price: Number(anchoredPrice.toFixed(2)),
        };
    });
}

function buildHeuristicTarget(
    entryPrice: number,
    direction: ConsensusResult['direction'],
    confidence: number,
    horizon: DebateHorizon
): number | null {
    if (direction !== 'LONG' && direction !== 'SHORT') return null;

    const baseMoveByHorizon: Record<DebateHorizon, number> = {
        short: 0.03,
        medium: 0.08,
        long: 0.15,
    };
    const confidenceFactor = clamp(confidence / 100, 0.4, 0.9);
    const signedMove = baseMoveByHorizon[horizon] * confidenceFactor * (direction === 'SHORT' ? -1 : 1);
    return Number((entryPrice * (1 + signedMove)).toFixed(2));
}

function isFallbackQuantData(quantData: any): boolean {
    return Boolean(quantData?.is_fallback || quantData?.model_source === 'fallback');
}

function quantStatusForPayload(quantData: any): 'ready' | 'fallback' {
    return isFallbackQuantData(quantData) ? 'fallback' : 'ready';
}

function quantPreviewResultForPayload(quantData: any): QuantPreviewResult | null {
    if (!quantData) return null;
    return { status: quantStatusForPayload(quantData), data: quantData, reason: null };
}

export function resolveQuantPreviewResult(routePreview: QuantPreviewResult, agentQuantData: any): QuantPreviewResult {
    const agentPreview = quantPreviewResultForPayload(agentQuantData);
    if (!agentPreview) return routePreview;
    if (agentPreview.status === 'ready') return agentPreview;
    if (routePreview.status === 'ready' || routePreview.status === 'fallback') return routePreview;
    return agentPreview;
}

function quantBadgeClass(status: QuantPreviewStatus): string {
    if (status === 'ready') return 'q-badge--bull';
    if (status === 'fallback' || status === 'loading') return 'q-badge--warn';
    if (status === 'error') return 'q-badge--warn';
    return 'q-badge--neutral';
}

function quantLabel(status: QuantPreviewStatus): string {
    if (status === 'no_ticker') return 'NO TICKER';
    return status.toUpperCase().replace('_', ' ');
}

function buildTradeSetupView(params: {
    ticker: string | null;
    horizon: DebateHorizon;
    quantData: any;
    quantStatus: QuantPreviewStatus;
    quantReason?: string | null;
    strategyQuote: StrategyQuote | null;
    consensus: ConsensusResult;
}): TradeSetupView {
    const { ticker, horizon, quantData, quantStatus, quantReason, strategyQuote, consensus } = params;
    const quantCurrentPrice = toPositiveFiniteNumber(quantData?.current_price);
    const entryPrice = quantCurrentPrice ?? toPositiveFiniteNumber(strategyQuote?.price);
    const hasQuantPayload = Boolean(quantData && !quantData.error);
    let graphData: TradeSetupPoint[] = [];
    let targetPrice: number | null = null;
    let targetSource: TradeSetupSource = null;
    let upperBand: number | null = null;
    let lowerBand: number | null = null;
    let priceTitle = '';
    let bandText = '';
    let sourceLabel = '';
    let chartVariant: TradeSetupVariant = 'quote';
    const fallbackQuant = isFallbackQuantData(quantData);

    if (hasQuantPayload) {
        if (horizon === 'short') {
            const rawPath = quantData.path_trajectories ?? quantData.forecast_path;
            const representativePath = deriveRepresentativePath(rawPath);
            targetPrice = toPositiveFiniteNumber(quantData.median_target) ?? (representativePath.length > 0 ? representativePath[representativePath.length - 1] : null);
            upperBand = toPositiveFiniteNumber(quantData.upper_target_10pct ?? quantData.upper_band);
            lowerBand = toPositiveFiniteNumber(quantData.lower_target_10pct ?? quantData.lower_band);
            if (targetPrice) {
                graphData = buildAlignedProjectionPath({ entryPrice, targetPrice, rawPath, horizon });
                targetSource = fallbackQuant ? 'FALLBACK' : 'QUANT';
                chartVariant = fallbackQuant ? 'fallback' : 'live';
                sourceLabel = fallbackQuant ? 'QUANT FALLBACK' : 'MONTE CARLO';
                priceTitle = 'Monte Carlo GBM Trajectory';
                bandText = `VaR (95%): ${toFiniteNumber(quantData.var_95) != null ? `$${Number(quantData.var_95).toFixed(2)}` : 'N/A'} | Kelly: ${toFiniteNumber(quantData.recommended_kelly_bet) != null ? `${(Number(quantData.recommended_kelly_bet) * 100).toFixed(1)}%` : 'N/A'}`;
            }
        } else if (horizon === 'medium') {
            const rawPath = quantData.forecast_path ?? quantData.path_trajectories;
            const forecastPath = deriveRepresentativePath(rawPath);
            targetPrice = toPositiveFiniteNumber(quantData.target_6_12_months) ?? (forecastPath.length > 0 ? forecastPath[forecastPath.length - 1] : null);
            upperBand = toPositiveFiniteNumber(quantData.upper_band);
            lowerBand = toPositiveFiniteNumber(quantData.lower_band);
            if (targetPrice) {
                graphData = buildAlignedProjectionPath({ entryPrice, targetPrice, rawPath, horizon });
                targetSource = fallbackQuant ? 'FALLBACK' : 'QUANT';
                chartVariant = fallbackQuant ? 'fallback' : 'live';
                sourceLabel = fallbackQuant ? 'QUANT FALLBACK' : 'ARIMAX/GARCH';
                priceTitle = 'ARIMAX & GARCH Projection';
                bandText = `Upper: ${toFiniteNumber(quantData.upper_band) != null ? `$${Number(quantData.upper_band).toFixed(2)}` : 'N/A'} | Lower: ${toFiniteNumber(quantData.lower_band) != null ? `$${Number(quantData.lower_band).toFixed(2)}` : 'N/A'}`;
            }
        } else {
            const dcfTarget = toPositiveFiniteNumber(quantData.target_12_36_months) ?? toPositiveFiniteNumber(quantData.dcf_intrinsic_value);
            if (entryPrice && dcfTarget) {
                const rawPath = quantData.forecast_path ?? quantData.path_trajectories;
                graphData = buildAlignedProjectionPath({ entryPrice, targetPrice: dcfTarget, rawPath, horizon });
                targetPrice = dcfTarget;
                targetSource = fallbackQuant ? 'FALLBACK' : 'QUANT';
                chartVariant = fallbackQuant ? 'fallback' : 'live';
                sourceLabel = fallbackQuant ? 'QUANT FALLBACK' : 'DCF/FAMA';
                upperBand = toPositiveFiniteNumber(quantData.upper_band);
                lowerBand = toPositiveFiniteNumber(quantData.lower_band);
                priceTitle = 'DCF Implied Growth Path';
                bandText = `Fama-French Premium: ${toFiniteNumber(quantData.fama_french_premium) != null ? `${(Number(quantData.fama_french_premium) * 100).toFixed(2)}%` : 'N/A'} | Band: ${toFiniteNumber(quantData.lower_band) != null ? `$${Number(quantData.lower_band).toFixed(2)}` : 'N/A'} - ${toFiniteNumber(quantData.upper_band) != null ? `$${Number(quantData.upper_band).toFixed(2)}` : 'N/A'}`;
            }
        }
    }

    if (entryPrice && !targetPrice) {
        const heuristicTarget = buildHeuristicTarget(entryPrice, consensus.direction, consensus.confidence, horizon);
        if (heuristicTarget) {
            targetPrice = heuristicTarget;
            targetSource = 'HEURISTIC';
            graphData = buildAlignedProjectionPath({ entryPrice, targetPrice: heuristicTarget, rawPath: [], horizon });
            priceTitle = 'Consensus Heuristic Guide';
            bandText = 'Quant target unavailable; heuristic target is consensus-weighted and not a model output.';
            sourceLabel = 'HEURISTIC';
            chartVariant = 'heuristic';
        } else {
            graphData = [{ day: 0, price: entryPrice }];
            priceTitle = `Live Quote (${strategyQuote?.source ?? 'Market'})`;
            bandText = 'Quant target unavailable; current market quote shown until price-path data returns.';
            sourceLabel = strategyQuote?.source ?? 'QUOTE';
            chartVariant = 'quote';
        }
    }

    const quantState = targetSource === 'QUANT'
        ? 'ready'
        : targetSource === 'FALLBACK'
            ? 'fallback'
            : quantStatus;

    return {
        ticker,
        entryPrice,
        targetPrice,
        targetSource,
        graphData,
        upperBand,
        lowerBand,
        priceTitle,
        bandText,
        sourceLabel,
        chartVariant,
        quantState,
        notice: targetSource === 'HEURISTIC'
            ? `Quant target/path is unavailable${quantReason ? ` (${quantReason})` : ''}. Showing a clearly labeled heuristic guide from consensus and live quote.`
            : quantState === 'no_ticker'
                ? 'No ticker detected. Add a ticker to the agenda or select a ticker-linked headline to request quant output.'
                : quantState === 'error'
                    ? `Quant target/path is unavailable${quantReason ? ` (${quantReason})` : ''}.`
                    : null,
    };
}

function classifyWarRoomFailure(error: unknown): { reason: AiRouteReason; notice: string } {
    if (error instanceof Error && error.name === 'AbortError') {
        return {
            reason: 'backend_timeout',
            notice: 'Live War Room analysis took too long; using local fallback debate output where needed.',
        };
    }

    if (error instanceof TypeError) {
        return {
            reason: 'backend_unreachable',
            notice: 'War Room backend transport failed for this agent; using local fallback output where needed.',
        };
    }

    return {
        reason: 'backend_error',
        notice: 'Live War Room is temporarily limited; using local fallback debate output where needed.',
    };
}

function pickDebateNotice(mode: DataMode, notices: Array<string | undefined>): string | null {
    const unique = Array.from(new Set(notices.filter(Boolean) as string[]));
    if (mode === 'simulation') {
        return unique.find((notice) => notice.toLowerCase().includes('simulation'))
            ?? 'Backend AI is in simulation mode. Consensus is not live-grounded.';
    }

    return unique[0] ?? null;
}

function buildWarRoomNotice(params: {
    liveCount: number;
    simulationCount: number;
    backendDegradedCount: number;
    localDegradedCount: number;
    transportFailureCount: number;
    notices: string[];
    mode: DataMode;
}): string | null {
    const degradedCount = params.backendDegradedCount + params.localDegradedCount;
    const totalCount = params.liveCount + params.simulationCount + degradedCount;

    if (totalCount > 0 && params.transportFailureCount === totalCount) {
        return 'Backend unavailable: all War Room agent requests failed before reaching the live runtime.';
    }

    if (degradedCount > 0) {
        const segments = [
            params.liveCount > 0 ? `${params.liveCount} live` : null,
            params.simulationCount > 0 ? `${params.simulationCount} simulation` : null,
            `${degradedCount} degraded`,
        ].filter(Boolean);
        return `Partial live analysis: ${segments.join(', ')}. Degraded agents are clearly labeled and excluded from live-grounded confidence.`;
    }

    return pickDebateNotice(params.mode, params.notices);
}

function buildFallbackArgument(agent: typeof AGENT_PERSONAS[number], headline: string): AgentArgument {
    return {
        agentId: agent.id,
        agentName: agent.name,
        position: agent.bias === 'BULLISH' ? 'LONG' : agent.bias === 'BEARISH' ? 'SHORT' : 'WAIT',
        confidence: 45 + Math.random() * 30,
        reasoning: `[Fallback] "${headline.slice(0, 50)}..." is being assessed without backend support.`,
        evidence: ['Frontend fallback active', 'Historical pattern placeholder'],
        scenarios: [{ direction: 'WAIT', asset: 'Broad Market', rationale: 'Await backend confirmation.', risk: 'LOW' }],
        timestamp: Date.now(),
    };
}

function buildConsensus(
    argumentsCollected: AgentArgument[],
    mode: DataMode,
    groundedAgentCount: number
): ConsensusResult {
    const longCount = argumentsCollected.filter((argument) => argument.position === 'LONG').length;
    const shortCount = argumentsCollected.filter((argument) => argument.position === 'SHORT').length;
    const hedgeCount = argumentsCollected.filter((argument) => argument.position === 'HEDGE').length;
    const total = Math.max(argumentsCollected.length, 1);
    const direction = longCount > shortCount && longCount >= hedgeCount ? 'LONG' : shortCount > longCount && shortCount >= hedgeCount ? 'SHORT' : hedgeCount > 0 ? 'HEDGE' : 'WAIT';
    const avgConfidence = Math.round(argumentsCollected.reduce((sum, argument) => sum + argument.confidence, 0) / total);

    return {
        direction: direction as any,
        confidence: avgConfidence,
        bullishProbability: Math.round((longCount / total) * 100),
        bearishProbability: Math.round((shortCount / total) * 100),
        neutralProbability: Math.round(((total - longCount - shortCount) / total) * 100),
        summary: mode === 'fallback'
            ? `[Fallback] ${total} agents debated. Consensus: ${direction} at ${avgConfidence}% confidence.`
            : `${total} agents debated. Consensus: ${direction}. ${mode === 'simulation' ? 'Backend simulation response.' : groundedAgentCount > 0 ? `${groundedAgentCount} agents used live web grounding.` : 'No live grounding used.'}`,
    };
}

async function runWithConcurrency<TInput, TOutput>(
    items: TInput[],
    limit: number,
    worker: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
    const results: TOutput[] = new Array(items.length);
    let cursor = 0;

    async function consume(): Promise<void> {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume()));
    return results;
}

function formatProjectionPrice(value: number): string {
    if (value >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    if (value < 10) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(2)}`;
}

function ProjectionChart(props: {
    title: string;
    points: TradeSetupPoint[];
    upperBand: number | null;
    lowerBand: number | null;
    sourceLabel: string;
    variant: TradeSetupVariant;
    isProfit: boolean;
}) {
    const { title, points, upperBand, lowerBand, sourceLabel, variant, isProfit } = props;
    const validPoints = points.filter((point) => Number.isFinite(point.day) && Number.isFinite(point.price) && point.price > 0);
    if (validPoints.length === 0) {
        return (
            <div data-testid="war-room-projection-chart" className="wr-chart wr-chart--empty">
                Projection data unavailable
            </div>
        );
    }

    const prices = validPoints.map((point) => point.price);
    if (upperBand && upperBand > 0) prices.push(upperBand);
    if (lowerBand && lowerBand > 0) prices.push(lowerBand);

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const pricePadding = Math.max((maxPrice - minPrice) * 0.12, maxPrice * 0.015, 1);
    const domainMin = minPrice - pricePadding;
    const domainMax = maxPrice + pricePadding;
    const domainRange = domainMax - domainMin || 1;
    const minDay = Math.min(...validPoints.map((point) => point.day));
    const maxDay = Math.max(...validPoints.map((point) => point.day));
    const dayRange = maxDay - minDay || 1;
    const toX = (day: number) => 7 + ((day - minDay) / dayRange) * 86;
    const toY = (price: number) => 82 - ((price - domainMin) / domainRange) * 66;
    const coordinates = validPoints.map((point) => ({ point, x: toX(point.day), y: toY(point.price) }));
    const linePoints = coordinates.map(({ x, y }) => `${x},${y}`).join(' ');
    const areaPath = coordinates.length > 1
        ? `M ${coordinates.map(({ x, y }) => `${x} ${y}`).join(' L ')} L ${coordinates[coordinates.length - 1].x} 86 L ${coordinates[0].x} 86 Z`
        : '';
    const upperY = upperBand ? toY(upperBand) : null;
    const lowerY = lowerBand ? toY(lowerBand) : null;
    const hasBand = upperY != null && lowerY != null && lowerY > upperY;
    const start = coordinates[0];
    const end = coordinates[coordinates.length - 1];
    const tone = isProfit ? 'up' : 'down';
    const estimated = variant !== 'live';

    return (
        <div data-testid="war-room-projection-chart" className="wr-chart">
            <div className="wr-chart__head">
                <div className="wr-chart__titles">
                    <p className="wr-chart__title">
                        {title}
                    </p>
                    <p className="wr-chart__range wr-num">
                        D{validPoints[0]?.day ?? 0} - D{validPoints[validPoints.length - 1]?.day ?? 0}
                    </p>
                </div>
                <span className={`q-badge ${variant === 'live' ? 'q-badge--bull' : variant === 'heuristic' ? 'q-badge--warn' : variant === 'fallback' ? 'q-badge--warn' : 'q-badge--neutral'}`}>
                    {sourceLabel || 'MODEL'}
                </span>
            </div>
            <div className="wr-chart__plot">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="wr-chart__svg" aria-hidden="true">
                    <rect x="0" y="0" width="100" height="100" className="wr-chart__frame" />
                    {[16, 34, 52, 70, 88].map((y) => (
                        <line key={y} x1="6" y1={y} x2="94" y2={y} className="wr-chart__grid" />
                    ))}
                    {[7, 28.5, 50, 71.5, 93].map((x) => (
                        <line key={x} x1={x} y1="10" x2={x} y2="88" className="wr-chart__grid wr-chart__grid--v" />
                    ))}
                    {hasBand && (
                        <>
                            <rect x="7" y={upperY} width="86" height={lowerY - upperY} className="wr-chart__band" />
                            <line x1="7" y1={upperY} x2="93" y2={upperY} className={`wr-chart__band-line${estimated ? ' wr-chart__band-line--estimate' : ''}`} />
                            <line x1="7" y1={lowerY} x2="93" y2={lowerY} className={`wr-chart__band-line${estimated ? ' wr-chart__band-line--estimate' : ''}`} />
                        </>
                    )}
                    {areaPath && <path d={areaPath} className={`wr-chart__area--${tone}`} />}
                    {linePoints && (
                        <polyline
                            className={`wr-chart__line wr-chart__line--${tone}${estimated ? ' wr-chart__line--estimate' : ''}`}
                            points={linePoints}
                        />
                    )}
                    {start && <circle cx={start.x} cy={start.y} r="2.2" className="wr-chart__start" />}
                    {end && (
                        <>
                            <line x1={end.x} y1="12" x2={end.x} y2="88" className="wr-chart__marker" />
                            <circle cx={end.x} cy={end.y} r="3" className={`wr-chart__end wr-chart__end--${tone}`} />
                        </>
                    )}
                </svg>
                <div className="wr-chart__axis wr-num">
                    <span>{formatProjectionPrice(domainMax)}</span>
                    <span>{formatProjectionPrice((domainMax + domainMin) / 2)}</span>
                    <span>{formatProjectionPrice(domainMin)}</span>
                </div>
                {end && (
                    <div className={`wr-chart__tag wr-chart__tag--${tone} wr-num`} style={{ top: `${Math.max(10, Math.min(116, end.y * 1.52 - 8))}px` }}>
                        {formatProjectionPrice(end.point.price)}
                    </div>
                )}
            </div>
        </div>
    );
}

function formatAgentNotice(reason?: AiRouteReason | null, failureStage?: string | null, notice?: string): string {
    const label = reason === 'backend_timeout'
        ? 'Timeout'
        : reason === 'quant_unavailable'
            ? 'Quant unavailable'
            : reason === 'grounding_unavailable'
                ? 'Grounding limited'
                : reason === 'ai_simulation'
                    ? 'Simulation'
                    : failureStage === 'model'
                        ? 'Model fallback'
                        : 'Limited';

    return notice ? `${label}: ${notice}` : label;
}

export function inferTickerFromNewsItem(newsItem: NewsItem): string | null {
    const tickerMap: Record<string, string> = {
        apple: 'AAPL',
        microsoft: 'MSFT',
        google: 'GOOGL',
        alphabet: 'GOOGL',
        amazon: 'AMZN',
        tesla: 'TSLA',
        nvidia: 'NVDA',
        meta: 'META',
        netflix: 'NFLX',
        bitcoin: 'BTC-USD',
        ethereum: 'ETH-USD',
        intel: 'INTC',
        amd: 'AMD',
        palantir: 'PLTR',
        coinbase: 'COIN',
        oil: 'XOM',
    };

    const normalizeCandidate = (value?: string): string | null => {
        const candidate = value?.trim();
        if (!candidate) return null;
        const mapped = tickerMap[candidate.toLowerCase()];
        if (mapped) return mapped;
        const normalized = candidate.toUpperCase();
        if (/^[A-Z]{1,5}(-USD|=F)?$/.test(normalized)) return normalized;
        return null;
    };

    for (const explicitTicker of [...(newsItem.relatedTickers ?? []), ...(newsItem.affectedAssets ?? [])]) {
        const normalized = normalizeCandidate(explicitTicker);
        if (normalized) return normalized;
    }

    const headlineLower = newsItem.headline.toLowerCase();
    for (const [name, ticker] of Object.entries(tickerMap)) {
        if (headlineLower.includes(name)) return ticker;
    }

    const tickerMatch = newsItem.headline.match(/\$([A-Z]{1,5}(?:-USD|=F)?)/);
    return tickerMatch ? tickerMatch[1] : null;
}

const WarRoomPage: React.FC = () => {
    const navigate = useNavigate();
    const { news, setNewsItems } = useNewsStore();
    const { isDebating, startDebate, addArgument, setAgentProgress, finalizeDebate, getDebateForNews, agentProgress, abortDebate } = useAgentStore();
    const newsQuery = useNews();

    const [selectedNewsId, setSelectedNewsId] = useState<string>('');
    const [selectedNewsItem, setSelectedNewsItem] = useState<NewsItem | null>(null);
    const [groundingSources, setGroundingSources] = useState<Record<string, { title: string; uri: string }[]>>({});
    const [agentNotices, setAgentNotices] = useState<Record<string, string>>({});
    const [usingGrounding, setUsingGrounding] = useState(false);
    const [customTopic, setCustomTopic] = useState('');
    const [customTicker, setCustomTicker] = useState('');
    const [horizon, setHorizon] = useState<DebateHorizon>('long');
    const [quantData, setQuantData] = useState<any>(null);
    const [quantPreviewState, setQuantPreviewState] = useState<QuantPreviewState>({ status: 'idle', reason: null });
    const [debateMode, setDebateMode] = useState<DataMode | null>(null);
    const [debateNotice, setDebateNotice] = useState<string | null>(null);
    const [strategyNotice, setStrategyNotice] = useState<string | null>(null);
    const [strategyQuote, setStrategyQuote] = useState<StrategyQuote | null>(null);
    const [executeTicket, setExecuteTicket] = useState<StrategyTicket | null>(null);
    const [executeQuantity, setExecuteQuantity] = useState('1');
    const [executeMaxQuantity, setExecuteMaxQuantity] = useState<number | null>(null);
    const [executeError, setExecuteError] = useState<string | null>(null);
    const [isExecutingTrade, setIsExecutingTrade] = useState(false);
    const activeRunRef = useRef(0);
    const quantAbortRef = useRef<AbortController | null>(null);
    const agentAbortControllersRef = useRef<AbortController[]>([]);
    const previousHorizonRef = useRef<DebateHorizon>('long');

    const availableNews = news.slice(0, 3);
    const currentDebate = selectedNewsId ? getDebateForNews(selectedNewsId) : null;

    useEffect(() => {
        if (!selectedNewsItem || !currentDebate?.consensus || isDebating) return;
        const ticker = inferTickerFromNewsItem(selectedNewsItem);
        if (!ticker) return;
        let cancelled = false;

        (async () => {
            try {
                const response = await apiClient.get('/api/news/prices', { params: { symbols: ticker } });
                const quote = response.data.prices?.[0];
                if (!cancelled && quote?.price) {
                    setStrategyQuote({
                        symbol: quote.symbol,
                        price: quote.price,
                        source: quote.source,
                        updatedAt: quote.updatedAt,
                    });
                }
            } catch {
                if (!cancelled) setStrategyQuote(null);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [currentDebate?.consensus, isDebating, selectedNewsItem]);

    useEffect(() => {
        if (news.length === 0 && newsQuery.data) {
            setNewsItems(newsQuery.data.items, newsQuery.data.mode);
        }
    }, [news.length, newsQuery.data, setNewsItems]);

    const cancelActiveRequests = () => {
        activeRunRef.current += 1;
        quantAbortRef.current?.abort();
        quantAbortRef.current = null;
        agentAbortControllersRef.current.forEach((controller) => controller.abort());
        agentAbortControllersRef.current = [];
    };

    const isCurrentRun = (runId: number) => activeRunRef.current === runId;

    const fetchQuantPreview = async (newsItem: NewsItem, runId: number, nextHorizon: DebateHorizon): Promise<QuantPreviewResult> => {
        const ticker = inferTickerFromNewsItem(newsItem);
        if (!ticker) return { status: 'no_ticker', data: null, reason: 'No ticker detected for this debate.' };

        const horizonEndpoint = nextHorizon === 'short' ? 'short-term' : nextHorizon === 'medium' ? 'medium-term' : 'long-term';
        const controller = new AbortController();
        quantAbortRef.current = controller;

        try {
            const response = await apiFetch(`/api/quant/${horizonEndpoint}`, {
                method: 'POST',
                body: JSON.stringify({ ticker, risk_free_rate: 0.04 }),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(AI_RUNTIME_CONFIG.warRoomQuantTimeoutMs)]),
            });

            const payload = await response.json().catch(() => null);
            if (!isCurrentRun(runId)) return { status: 'error', data: null, reason: 'Debate run changed before quant completed.' };

            if (!response.ok) {
                return { status: 'error', data: null, reason: payload?.error ?? payload?.reason ?? `Quant request failed (${response.status})` };
            }

            const data = payload?.data ?? null;
            if (!data) {
                return { status: 'error', data: null, reason: 'Quant response did not include price-path data.' };
            }

            return {
                status: payload?.isFallback || isFallbackQuantData(data) ? 'fallback' : 'ready',
                data,
                reason: payload?.provenance?.degradationReason ?? payload?.reason ?? null,
            };
        } catch (error) {
            return { status: 'error', data: null, reason: getApiErrorMessage(error, 'Quant preview failed.') };
        } finally {
            if (quantAbortRef.current === controller) {
                quantAbortRef.current = null;
            }
        }
    };

    const handleInterrupt = (notice = 'War Room run interrupted. Restart the debate to refresh the room.') => {
        cancelActiveRequests();
        abortDebate();
        setDebateMode('fallback');
        setDebateNotice(notice);
    };

    useEffect(() => {
        if (previousHorizonRef.current !== horizon && isDebating) {
            cancelActiveRequests();
            abortDebate();
            setDebateMode('fallback');
            setDebateNotice('War Room run interrupted because the horizon changed. Restart the debate to refresh the room.');
        }
        previousHorizonRef.current = horizon;
    }, [abortDebate, horizon, isDebating]);

    useEffect(() => () => {
        cancelActiveRequests();
    }, []);

    const runDebate = async (newsItem: NewsItem, nextHorizon: DebateHorizon = horizon) => {
        cancelActiveRequests();
        setUsingGrounding(false);
        setGroundingSources({});
        setAgentNotices({});
        setQuantData(null);
        setQuantPreviewState({ status: inferTickerFromNewsItem(newsItem) ? 'loading' : 'no_ticker', reason: null });
        setStrategyQuote(null);
        setDebateMode(null);
        setDebateNotice(null);
        setStrategyNotice(null);
        startDebate(newsItem);
        setSelectedNewsId(newsItem.id);
        setSelectedNewsItem(newsItem);
        const runId = activeRunRef.current;
        const quantPreviewPromise = fetchQuantPreview(newsItem, runId, nextHorizon);
        let backendFailureNotice: string | null = null;

        try {
            let backendMode: DataMode = 'live';
            let quantPayload: any = null;
            const argumentsCollected: AgentArgument[] = [];
            const fallbackArguments: AgentArgument[] = [];
            const sources: Record<string, { title: string; uri: string }[]> = {};
            const notices: string[] = [];
            let liveAgentCount = 0;
            let simulationAgentCount = 0;
            let backendDegradedAgentCount = 0;
            let localDegradedAgentCount = 0;
            let transportFailureCount = 0;
            const results = await runWithConcurrency(
                AGENT_PERSONAS,
                AI_RUNTIME_CONFIG.warRoomAgentConcurrency,
                async (agent) => {
                    if (!isCurrentRun(runId)) {
                        throw new DOMException('Debate aborted', 'AbortError');
                    }

                    const controller = new AbortController();
                    agentAbortControllersRef.current.push(controller);
                    setAgentProgress(agent.id, 'thinking');

                    try {
                        const response = await apiFetch('/api/ai/agent-analysis', {
                            method: 'POST',
                            body: JSON.stringify({
                                headline: newsItem.headline,
                                alphaScore: newsItem.score ?? 0,
                                agentId: agent.id,
                                horizon: nextHorizon,
                                ticker: inferTickerFromNewsItem(newsItem) ?? undefined,
                            }),
                            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(AI_RUNTIME_CONFIG.warRoomClientTimeoutMs)]),
                        });

                        const payload = await response.json().catch(() => null);

                        if (!response.ok) {
                            const reason = payload?.reason ?? (response.status === 504 ? 'backend_timeout' : 'backend_error');
                            const notice = payload?.notice ?? (response.status === 504
                                ? 'Live War Room analysis took too long; using local fallback debate output where needed.'
                                : 'Live War Room is temporarily limited; using local fallback debate output where needed.');
                            return {
                                status: 'error' as const,
                                agentId: agent.id,
                                reason,
                                notice: formatAgentNotice(reason, payload?.failureStage, notice),
                                transportFailure: false,
                            } satisfies AgentAnalysisFetchResult;
                        }

                        const argument: AgentArgument = {
                            agentId: payload.agentId,
                            agentName: payload.agentName,
                            position: payload.position ?? 'WAIT',
                            confidence: payload.confidence ?? 50,
                            reasoning: payload.reasoning ?? '',
                            evidence: payload.evidence ?? [],
                            scenarios: payload.scenarios ?? [],
                            timestamp: payload.timestamp ?? Date.now(),
                        };

                        return { status: 'success' as const, argument, payload } satisfies AgentAnalysisFetchResult;
                    } catch (error) {
                        const failure = classifyWarRoomFailure(error);
                        return {
                            status: 'error' as const,
                            agentId: agent.id,
                            reason: failure.reason,
                            notice: formatAgentNotice(failure.reason, null, failure.notice),
                            transportFailure: failure.reason === 'backend_unreachable',
                        } satisfies AgentAnalysisFetchResult;
                    }
                }
            );

            if (!isCurrentRun(runId)) {
                return;
            }

            for (const result of results) {
                if (result.status !== 'success') {
                    const agent = AGENT_PERSONAS.find((item) => item.id === result.agentId);
                    if (agent) {
                        fallbackArguments.push(buildFallbackArgument(agent, newsItem.headline));
                        setAgentNotices((current) => ({ ...current, [agent.id]: result.notice }));
                        setAgentProgress(agent.id, 'done');
                    }
                    localDegradedAgentCount += 1;
                    if (result.transportFailure) {
                        transportFailureCount += 1;
                    }
                    if (!backendFailureNotice) {
                        backendFailureNotice = result.notice;
                    }
                    continue;
                }

                const { argument, payload } = result;
                argumentsCollected.push(argument);
                addArgument(newsItem.id, argument);
                setAgentProgress(argument.agentId, 'done');

                if (payload.mode === 'live') liveAgentCount += 1;
                if (payload.mode === 'simulation') {
                    backendMode = 'simulation';
                    simulationAgentCount += 1;
                }
                if (payload.mode === 'fallback') {
                    backendMode = 'fallback';
                    backendDegradedAgentCount += 1;
                }
                if (payload.notice) notices.push(payload.notice);
                if (payload.notice) {
                    setAgentNotices((current) => ({ ...current, [argument.agentId]: formatAgentNotice(payload.reason, payload.failureStage, payload.notice) }));
                }
                if (payload.sources?.length > 0) {
                    sources[argument.agentId] = payload.sources;
                }
                if (payload.quantData) {
                    quantPayload = payload.quantData;
                }
            }

            for (const fallbackArgument of fallbackArguments) {
                addArgument(newsItem.id, fallbackArgument);
            }

            const previewResult = quantPayload && !isFallbackQuantData(quantPayload)
                ? quantPreviewResultForPayload(quantPayload)!
                : resolveQuantPreviewResult(await quantPreviewPromise, quantPayload);
            if (!isCurrentRun(runId)) {
                return;
            }

            setQuantPreviewState({ status: previewResult.status, reason: previewResult.reason ?? null });
            if (previewResult.data) {
                setQuantData(previewResult.data);
            }

            if (Object.keys(sources).length > 0) {
                setGroundingSources(sources);
                setUsingGrounding(true);
            }

            const nextMode: DataMode = fallbackArguments.length > 0 ? 'fallback' : backendMode;
            const nextArguments = [...argumentsCollected, ...fallbackArguments];
            setDebateMode(nextMode);
            setDebateNotice(buildWarRoomNotice({
                liveCount: liveAgentCount,
                simulationCount: simulationAgentCount,
                backendDegradedCount: backendDegradedAgentCount,
                localDegradedCount: localDegradedAgentCount,
                transportFailureCount,
                notices,
                mode: nextMode,
            }));
            finalizeDebate(newsItem.id, buildConsensus(nextArguments, nextMode, Object.keys(sources).length));
            return;
        } catch {
            if (!isCurrentRun(runId)) {
                return;
            }

            const previewResult = await quantPreviewPromise;
            if (!isCurrentRun(runId)) {
                return;
            }

            setQuantPreviewState({ status: previewResult.status, reason: previewResult.reason ?? null });
            setQuantData(previewResult.data);
            setDebateMode('fallback');
            setDebateNotice(backendFailureNotice ?? 'Backend unavailable: all War Room agent requests failed before reaching the live runtime.');
            const argumentsCollected: AgentArgument[] = [];

            for (const agent of AGENT_PERSONAS) {
                setAgentProgress(agent.id, 'thinking');
                await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 100));

                const fallback = buildFallbackArgument(agent, newsItem.headline);
                argumentsCollected.push(fallback);
                addArgument(newsItem.id, fallback);
                setAgentProgress(agent.id, 'done');
            }

            finalizeDebate(newsItem.id, buildConsensus(argumentsCollected, 'fallback', 0));
        } finally {
            agentAbortControllersRef.current = [];
        }
    };

    const handleCustomSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        if (!customTopic.trim() || isDebating) return;
        const tickerCandidate = customTicker.trim().toUpperCase();
        const normalizedTicker = /^[A-Z]{1,5}(-USD|=F)?$/.test(tickerCandidate) ? tickerCandidate : '';

        const topic: NewsItem = {
            id: `custom-topic-${Date.now()}`,
            headline: customTopic,
            category: 'ALL' as any,
            source: 'User Input',
            timestamp: Date.now(),
            relatedTickers: normalizedTicker ? [normalizedTicker] : undefined,
            isAnalyzed: false,
            isAnalysing: false,
        };

        runDebate(topic, horizon);
        setCustomTopic('');
        setCustomTicker('');
    };

    const buildStrategyTicket = (): StrategyTicket | null => {
        if (!selectedNewsItem || !currentDebate?.consensus) return null;
        const ticker = inferTickerFromNewsItem(selectedNewsItem);
        if (!ticker) return null;
        const quantPrice = toPositiveFiniteNumber(quantData?.current_price);
        const quotePrice = toPositiveFiniteNumber(strategyQuote?.price);

        const direction = currentDebate.consensus.direction;
        return {
            ticker,
            side: direction === 'SHORT' ? 'SELL' : 'BUY',
            price: quantPrice ?? quotePrice ?? undefined,
            source: quantPrice ? (isFallbackQuantData(quantData) ? 'Quant Fallback' : 'Quant') : strategyQuote?.source,
            actionable: direction === 'LONG' || direction === 'SHORT',
        };
    };

    const handleLogToPortfolio = () => {
        const ticket = buildStrategyTicket();
        if (!ticket) {
            setStrategyNotice('No ticker was inferred for this debate. Add a ticker to the agenda and rerun the room.');
            return;
        }

        navigate('/portfolio', {
            state: {
                strategyTicket: {
                    ticker: ticket.ticker,
                    side: ticket.side,
                    price: ticket.price,
                    source: ticket.source,
                },
            },
        });
    };

    const openExecuteStrategy = async () => {
        const ticket = buildStrategyTicket();
        if (!ticket) {
            setStrategyNotice('No actionable ticker was inferred for this debate.');
            return;
        }
        if (!ticket.actionable) {
            setStrategyNotice('HEDGE and WAIT consensus can be logged to the portfolio, but no paper order is executed automatically.');
            return;
        }

        setStrategyNotice(null);
        setExecuteError(null);
        setExecuteMaxQuantity(null);
        setExecuteQuantity('1');
        setExecuteTicket(ticket);

        try {
            const priceResponse = await apiClient.get('/api/news/prices', { params: { symbols: ticket.ticker } });
            const quote = priceResponse.data.prices?.[0];
            if (quote?.price) {
                setExecuteTicket({ ...ticket, price: quote.price, source: quote.source });
            }
        } catch {
            // Quant preview price remains usable for the confirmation modal.
        }

        if (ticket.side === 'SELL') {
            try {
                const portfolioResponse = await apiClient.get('/api/portfolio/state');
                const position = portfolioResponse.data.portfolio?.positions?.find((item: { ticker: string }) => item.ticker === ticket.ticker);
                if (!position) {
                    setExecuteError(`No open ${ticket.ticker} position is available to sell.`);
                    return;
                }
                setExecuteMaxQuantity(position.quantity);
                setExecuteQuantity(String(Math.min(1, position.quantity)));
            } catch (error) {
                setExecuteError(getApiErrorMessage(error, 'Could not verify the open position before selling.'));
            }
        }
    };

    const submitExecuteStrategy = async () => {
        if (!executeTicket?.price) {
            setExecuteError('No paper trade price is available yet.');
            return;
        }
        const qty = Number.parseFloat(executeQuantity);
        if (!(qty > 0)) {
            setExecuteError('Quantity must be greater than zero.');
            return;
        }
        if (executeTicket.side === 'SELL' && executeMaxQuantity != null && qty > executeMaxQuantity + Number.EPSILON) {
            setExecuteError(`Quantity exceeds available ${executeTicket.ticker} position.`);
            return;
        }

        setIsExecutingTrade(true);
        setExecuteError(null);
        try {
            await apiClient.post('/api/portfolio/trade', {
                ticker: executeTicket.ticker,
                type: executeTicket.side,
                quantity: qty,
                price: executeTicket.price,
            });
            setExecuteTicket(null);
            setStrategyNotice(`${executeTicket.side} ${executeTicket.ticker} paper trade entry was logged to the portfolio.`);
        } catch (error) {
            setExecuteError(getApiErrorMessage(error, 'Paper trade logging failed.'));
        } finally {
            setIsExecutingTrade(false);
        }
    };

    const renderMiniChart = (agentId: string, position: string, confidence: number) => {
        const isBull = position === 'LONG';
        const isBear = position === 'SHORT';
        const toneClass = isBull ? 'wr-tone--bull' : isBear ? 'wr-tone--bear' : 'wr-tone--warn';
        const heights = [30, 45, Math.max(confidence - 20, 10), confidence];

        if (agentId === 'agent-risk') {
            return (
                <div className={`wr-signal ${toneClass}`}>
                    <p className="wr-signal__label">Risk Confidence</p>
                    <div className="wr-meter" aria-hidden="true">
                        <div className="wr-meter__fill" style={{ width: `${confidence}%` }} />
                    </div>
                    <p className="wr-meter__caption wr-num">Cash: {Math.round(100 - confidence)}% | Target: {Math.round(confidence)}%</p>
                </div>
            );
        }

        return (
            <div className={`wr-signal ${toneClass}`}>
                <p className="wr-signal__label">
                    <BarChart2 size={12} aria-hidden="true" /> Signal Profile
                </p>
                <div className="wr-signal__bars" aria-hidden="true">
                    {heights.map((height, index) => (
                        <div key={index} className={`wr-signal__bar${index === 3 ? ' wr-signal__bar--current' : ''}`} style={{ height: `${isBear ? 100 - height : height}%` }} />
                    ))}
                </div>
            </div>
        );
    };

    const renderExecutiveSummary = () => {
        if (!currentDebate?.consensus || isDebating) return null;

        let profitPercent = 0;
        let isProfit = false;
        const setupView = buildTradeSetupView({
            ticker: selectedNewsItem ? inferTickerFromNewsItem(selectedNewsItem) : null,
            horizon,
            quantData,
            quantStatus: quantPreviewState.status,
            quantReason: quantPreviewState.reason,
            strategyQuote,
            consensus: currentDebate.consensus,
        });
        const { graphData, targetPrice, entryPrice: currentSetupPrice, priceTitle, bandText } = setupView;

        if (currentSetupPrice && targetPrice) {
            profitPercent = currentDebate.consensus.direction === 'SHORT'
                ? ((currentSetupPrice - targetPrice) / currentSetupPrice) * 100
                : ((targetPrice - currentSetupPrice) / currentSetupPrice) * 100;
            isProfit = profitPercent > 0;
        }

        const { bullishProbability, bearishProbability, neutralProbability } = currentDebate.consensus;
        const debateArguments = currentDebate.arguments;
        const asOfTime = debateArguments.length > 0
            ? new Date(Math.max(...debateArguments.map((item) => item.timestamp))).toLocaleTimeString()
            : null;

        return (
            <section className="wr-board" aria-labelledby="wr-board-title">
                <div className="wr-board__head">
                    <div>
                        <p className="wr-label">EXECUTIVE SUMMARY & ACTIONS</p>
                        <h3 id="wr-board-title" className="wr-board__title">Editorial Board Decision</h3>
                    </div>
                    <p className="wr-board__prov wr-num">
                        {provenanceLabel(debateMode)}{asOfTime ? ` · as of ${asOfTime}` : ''}
                    </p>
                </div>

                <div className="wr-board__grid">
                    <div className="wr-board__main">
                        <div className="wr-verdict">
                            <span className={`q-badge wr-verdict__badge ${DIRECTION_STYLE[currentDebate.consensus.direction] ?? 'q-badge--neutral'}`}>
                                {currentDebate.consensus.direction}
                            </span>
                            <span className="wr-verdict__confidence wr-num">
                                {currentDebate.consensus.confidence}%
                            </span>
                            <span className="wr-verdict__caption">Room Confidence</span>
                        </div>
                        <p className="wr-summary">
                            {currentDebate.consensus.summary}
                        </p>

                        <div className="wr-votes">
                            <div className="wr-votes__head">
                                <p className="wr-label">Vote distribution</p>
                            </div>
                            <div className="wr-votes__bar" aria-hidden="true">
                                {bullishProbability > 0 && <div className="wr-votes__seg wr-votes__seg--for" style={{ width: `${bullishProbability}%` }} />}
                                {bearishProbability > 0 && <div className="wr-votes__seg wr-votes__seg--against" style={{ width: `${bearishProbability}%` }} />}
                                {neutralProbability > 0 && <div className="wr-votes__seg wr-votes__seg--other" style={{ width: `${neutralProbability}%` }} />}
                            </div>
                            <ul className="wr-votes__legend wr-num">
                                <li className="wr-votes__key"><span className="wr-votes__swatch wr-votes__seg--for" aria-hidden="true" />For (long) {bullishProbability}%</li>
                                <li className="wr-votes__key"><span className="wr-votes__swatch wr-votes__seg--against" aria-hidden="true" />Against (short) {bearishProbability}%</li>
                                <li className="wr-votes__key"><span className="wr-votes__swatch wr-votes__seg--other" aria-hidden="true" />Hedge / abstain {neutralProbability}%</li>
                            </ul>
                        </div>

                        <div className="wr-badges">
                            <span className="q-badge q-badge--neutral">AI {debateMode ?? 'pending'}</span>
                            <span className={`q-badge ${usingGrounding ? 'q-badge--bull' : 'q-badge--neutral'}`}>
                                {usingGrounding ? 'GROUNDED' : 'UNGROUNDED'}
                            </span>
                            <span className={`q-badge ${quantBadgeClass(setupView.quantState)}`}>
                                QUANT {quantLabel(setupView.quantState)}
                            </span>
                            {strategyQuote && <span className="q-badge q-badge--neutral">QUOTE {strategyQuote.source}</span>}
                        </div>
                    </div>
                    <div className="wr-board__actions">
                        <button className="q-btn wr-btn wr-btn--primary" onClick={() => void openExecuteStrategy()}>
                            PREPARE PAPER TRADE
                        </button>
                        <button className="q-btn wr-btn" onClick={handleLogToPortfolio}>
                            LOG TO PORTFOLIO
                        </button>
                    </div>
                </div>
                {strategyNotice && (
                    <div className="wr-notice wr-notice--info">
                        {strategyNotice}
                    </div>
                )}
                {setupView.notice && (
                    <div className="wr-notice wr-notice--caution">
                        {setupView.notice}
                    </div>
                )}

                <div className="wr-report">
                    <p className="wr-label wr-report__title">
                        STRATEGIC TRADE SETUP
                    </p>

                    {!currentSetupPrice ? (
                        <div data-testid={setupView.quantState === 'no_ticker' ? 'war-room-quant-no-ticker' : setupView.quantState === 'error' ? 'war-room-quant-error' : 'war-room-quant-pending'} className="wr-pending">
                            <Clock size={18} className="wr-pending__icon" aria-hidden="true" />
                            <p>
                                {setupView.quantState === 'no_ticker'
                                    ? 'No ticker detected. Add a ticker to the agenda or select a ticker-linked headline.'
                                    : setupView.quantState === 'error'
                                        ? `Quant price-path failed${quantPreviewState.reason ? `: ${quantPreviewState.reason}` : '.'}`
                                        : 'Quant engine is processing price-path data for this debate.'}
                            </p>
                        </div>
                    ) : (
                        <div data-testid="war-room-quant-summary" className="wr-setup">
                            <div className="wr-setup__figures">
                                <div>
                                    <p className="wr-figure__label">Entry Price</p>
                                    <p className="wr-figure__value wr-num">
                                        ${currentSetupPrice.toFixed(2)}
                                    </p>
                                    {!quantData && strategyQuote && (
                                        <p className="wr-figure__sub wr-num">
                                            {strategyQuote.source} {new Date(strategyQuote.updatedAt).toLocaleTimeString()}
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <p className="wr-figure__label">Target Price</p>
                                    <div className="wr-figure__row">
                                        <p className={`wr-figure__value wr-num ${isProfit ? 'wr-figure__value--up' : 'wr-figure__value--down'}`}>
                                            {targetPrice ? `$${targetPrice.toFixed(2)}` : 'N/A'}
                                        </p>
                                        {setupView.targetSource && (
                                            <span className={`q-badge ${setupView.targetSource === 'QUANT' ? 'q-badge--bull' : 'q-badge--warn'}`}>
                                                {setupView.targetSource}
                                            </span>
                                        )}
                                        {profitPercent !== 0 && (
                                            <span className={`wr-delta wr-num ${isProfit ? 'wr-delta--up' : 'wr-delta--down'}`}>
                                                <span aria-hidden="true">{isProfit ? '▲ ' : '▼ '}</span>{isProfit ? '+' : ''}{profitPercent.toFixed(2)}%
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <p className="wr-band">{bandText}</p>
                                </div>
                            </div>

                            <ProjectionChart
                                title={priceTitle}
                                points={graphData}
                                upperBand={setupView.upperBand}
                                lowerBand={setupView.lowerBand}
                                sourceLabel={setupView.sourceLabel}
                                variant={setupView.chartVariant}
                                isProfit={isProfit}
                            />
                        </div>
                    )}
                </div>
            </section>
        );
    };

    const filedCount = currentDebate?.arguments.length ?? 0;
    const quorumTotal = AGENT_PERSONAS.length;

    // Presentation only: one row per agent, shared by the agent list and the debate record.
    const agentRows = AGENT_PERSONAS.map((agent) => {
        const status = agentProgress[agent.id] ?? 'pending';
        const argument = currentDebate?.arguments.find((item) => item.agentId === agent.id);
        const stance = argument ? STANCE[argument.position] ?? { label: argument.position, tone: 'abstain' as const } : null;
        return { agent, status, argument, stance };
    });
    const stanceTally = { for: 0, against: 0, hedge: 0, abstain: 0 };
    agentRows.forEach(({ stance }) => {
        if (stance) stanceTally[stance.tone] += 1;
    });

    return (
        <div className="wr">
            <header className="q-page-header">
                <div>
                    <p className="wr-label wr-kicker">Opinion · The Boardroom</p>
                    <h2 className="q-page-title">
                        Strategy Boardroom
                    </h2>
                    <p className="q-page-sub">
                        Set the agenda. Let 4 specialized AI agents debate and visualize optimal strategies.
                    </p>
                </div>
                {(usingGrounding || (debateMode && debateMode !== 'live')) && (
                    <div className="wr-flags">
                        {usingGrounding && (
                            <span className="wr-flag wr-flag--live">
                                LIVE GROUNDED
                            </span>
                        )}
                        {debateMode && debateMode !== 'live' && (
                            <span className={`wr-flag ${debateMode === 'simulation' ? 'wr-flag--simulation' : 'wr-flag--fallback'}`}>
                                {debateMode.toUpperCase()}
                            </span>
                        )}
                    </div>
                )}
            </header>

            <div className="q-scroll-area">
                <div className="wr-body">
                    <div className={`wr-agenda${isDebating ? '' : ' wr-agenda--open'}`}>
                        <p className="wr-label">SET THE AGENDA</p>
                        <div className="wr-agenda__row">
                            <div className="wr-horizons" role="group" aria-label="Horizon">
                                <button data-testid="war-room-horizon-short" onClick={() => setHorizon('short')} className="wr-horizon" aria-pressed={horizon === 'short'}>
                                    3-6 Months (Monte Carlo)
                                </button>
                                <button data-testid="war-room-horizon-medium" onClick={() => setHorizon('medium')} className="wr-horizon" aria-pressed={horizon === 'medium'}>
                                    6-12 Months (ARIMAX/GARCH)
                                </button>
                                <button data-testid="war-room-horizon-long" onClick={() => setHorizon('long')} className="wr-horizon" aria-pressed={horizon === 'long'}>
                                    12-36 Months (DCF/Fama-French)
                                </button>
                            </div>
                            <form onSubmit={handleCustomSubmit} className="wr-agenda__form">
                                <label className="wr-field wr-field--topic">
                                    Question for the board
                                    <input
                                        type="text"
                                        value={customTopic}
                                        onChange={(event) => setCustomTopic(event.target.value)}
                                        placeholder="E.g. What is the impact of rising oil prices on tech stocks?"
                                        disabled={isDebating}
                                        className="q-input wr-input"
                                    />
                                </label>
                                <label className="wr-field wr-field--ticker">
                                    Ticker
                                    <input
                                        type="text"
                                        value={customTicker}
                                        onChange={(event) => setCustomTicker(event.target.value.toUpperCase())}
                                        placeholder="Ticker"
                                        disabled={isDebating}
                                        className="q-input wr-input wr-input--ticker"
                                        maxLength={10}
                                    />
                                </label>
                                <button type="submit" disabled={isDebating || !customTopic.trim()} className="q-btn wr-btn wr-btn--primary">
                                    {isDebating ? <Clock size={18} aria-label="Debate in progress" /> : <><Send size={18} aria-hidden="true" /> Initiate Debate</>}
                                </button>
                            </form>
                        </div>

                        <div className="wr-quick">
                            <span className="wr-quick__label">Or quick select:</span>
                            {availableNews.map((item) => (
                                <button
                                    key={item.id}
                                    data-testid={`war-room-topic-${item.id}`}
                                    onClick={() => !isDebating && runDebate(item, horizon)}
                                    disabled={isDebating}
                                    className="wr-chip"
                                >
                                    {item.headline}
                                </button>
                            ))}
                        </div>
                    </div>

                    {debateNotice && (
                        <div data-testid="war-room-notice" className={`wr-notice ${debateMode === 'simulation' ? 'wr-notice--warn' : 'wr-notice--bear'}`}>
                            <p>
                                {debateNotice}
                            </p>
                        </div>
                    )}

                    {selectedNewsId && (
                        <>
                            <div className="wr-section-head">
                                <p className="wr-label">BOARDROOM ANALYSIS</p>
                                <h3 className="wr-section-head__title">The Opinion Page</h3>
                            </div>

                            <div className="wr-room">
                                <section className="wr-panel wr-panel--agents" aria-labelledby="wr-agents-title">
                                    <h3 id="wr-agents-title" className="wr-panel__title">Agents · positions filed</h3>
                                    <ul className="wr-agents">
                                        {agentRows.map(({ agent, status, argument, stance }) => (
                                            <li key={agent.id} className={`wr-agent${status === 'thinking' ? ' wr-agent--thinking' : ''}`}>
                                                <div className="wr-agent__who">
                                                    <span className="wr-agent__name">{agent.name}</span>
                                                    <span className="wr-role">{agent.specialization}</span>
                                                    {status === 'thinking' && <span className="wr-status"><Clock size={12} aria-hidden="true" /> Filing</span>}
                                                    {status === 'done' && <span className="wr-status wr-status--done"><CheckCircle size={12} aria-hidden="true" /> Filed</span>}
                                                </div>
                                                <div className="wr-agent__stance">
                                                    <span className={`wr-stance wr-stance--${stance ? stance.tone : 'pending'}`}>
                                                        <span aria-hidden="true">{STANCE_MARK[stance ? stance.tone : 'pending']} </span>{stance ? stance.label : 'AWAITING'}
                                                    </span>
                                                    {argument && (
                                                        <span className="wr-agent__meta wr-num">
                                                            {argument.position} · {Math.round(argument.confidence)}% confidence
                                                        </span>
                                                    )}
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                </section>

                                <section className="wr-panel wr-panel--record" aria-labelledby="wr-record-title">
                                    <h3 id="wr-record-title" className="wr-panel__title">Debate record</h3>
                                    <div className="wr-record">
                                        {agentRows.map(({ agent, status, argument }) => {
                                            const agentSources = groundingSources[agent.id] ?? [];
                                            const agentNotice = agentNotices[agent.id];
                                            const column = argument ? splitPullQuote(argument.reasoning) : null;

                                            return (
                                                <article key={agent.id} data-testid={`war-room-agent-${agent.id}`} className={`wr-entry${status === 'thinking' ? ' wr-entry--thinking' : status === 'done' ? ' wr-entry--done' : ''}`}>
                                                    <div className="wr-entry__who">
                                                        <p className="wr-byline">By {agent.name}</p>
                                                        {argument && (
                                                            <p className="wr-entry__prov wr-num">
                                                                {provenanceLabel(debateMode)} · as of {new Date(argument.timestamp).toLocaleTimeString()}
                                                            </p>
                                                        )}
                                                    </div>

                                                    {argument && column ? (
                                                        <div className="wr-entry__text">
                                                            {column.quote && <blockquote className="wr-pullquote">{column.quote}</blockquote>}
                                                            {column.body && (
                                                                <p className="wr-entry__body">
                                                                    {column.body}
                                                                </p>
                                                            )}
                                                            {agentNotice && (
                                                                <p className="wr-entry__degraded">
                                                                    DEGRADED: {agentNotice}
                                                                </p>
                                                            )}
                                                            {agentSources.length > 0 && (
                                                                <div className="wr-sources">
                                                                    <p className="wr-sources__label">
                                                                        <Globe size={12} aria-hidden="true" /> Verified Grounding
                                                                    </p>
                                                                    {agentSources.slice(0, 2).map((source, index) => (
                                                                        <a
                                                                            key={index}
                                                                            href={source.uri}
                                                                            target="_blank"
                                                                            rel="noreferrer"
                                                                            className="wr-sources__link"
                                                                        >
                                                                            <ExternalLink size={10} aria-hidden="true" />
                                                                            {source.title?.slice(0, 40) || source.uri?.slice(0, 40)}
                                                                        </a>
                                                                    ))}
                                                                </div>
                                                            )}
                                                            <div className="wr-entry__signal">
                                                                {renderMiniChart(agent.id, argument.position, argument.confidence)}
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <div className="wr-skeleton wr-entry__text">
                                                            <div className="q-skeleton wr-skeleton__line wr-skeleton__line--head" />
                                                            <div className="q-skeleton wr-skeleton__line" />
                                                            <div className="q-skeleton wr-skeleton__line wr-skeleton__line--short" />
                                                        </div>
                                                    )}
                                                </article>
                                            );
                                        })}
                                    </div>
                                </section>

                                <aside className="wr-panel wr-panel--decision" aria-labelledby="wr-quorum-title">
                                    <h3 id="wr-quorum-title" className="wr-panel__title wr-panel__title--bare">Quorum</h3>
                                    <div
                                        className="wr-quorum"
                                        role="meter"
                                        aria-label="Quorum: agent views filed"
                                        aria-valuemin={0}
                                        aria-valuemax={quorumTotal}
                                        aria-valuenow={Math.min(filedCount, quorumTotal)}
                                    >
                                        <p className="wr-quorum__text wr-num">
                                            <span className="wr-quorum__count">{filedCount} / {quorumTotal}</span> columns filed
                                        </p>
                                        <div className="wr-quorum__track" aria-hidden="true">
                                            {AGENT_PERSONAS.map((agent, index) => (
                                                <span key={agent.id} className={`wr-quorum__seg${index < filedCount ? ' wr-quorum__seg--filed' : ''}`} />
                                            ))}
                                        </div>
                                    </div>
                                    <dl className="wr-tally wr-num">
                                        <dt>For</dt><dd className="wr-tally__for">{stanceTally.for}</dd>
                                        <dt>Against</dt><dd className="wr-tally__against">{stanceTally.against}</dd>
                                        <dt>Hedge</dt><dd className="wr-tally__hedge">{stanceTally.hedge}</dd>
                                        {stanceTally.abstain > 0 && <><dt>Abstain</dt><dd>{stanceTally.abstain}</dd></>}
                                    </dl>
                                    <button data-testid="war-room-interrupt" onClick={() => handleInterrupt()} className="q-btn wr-btn wr-btn--interrupt">
                                        Hold On! (Interrupt)
                                    </button>
                                </aside>
                            </div>

                            {renderExecutiveSummary()}
                        </>
                    )}
                </div>
            </div>
            {executeTicket && (
                <div className="wr-modal">
                    <div className="wr-modal__card">
                        <p className="wr-label wr-modal__title">LOG PAPER TRADE</p>
                        <div className="wr-ticket wr-num">
                            <div className="wr-ticket__row">
                                <span className="wr-ticket__key">Ticker</span>
                                <strong>{executeTicket.ticker}</strong>
                            </div>
                            <div className="wr-ticket__row">
                                <span className="wr-ticket__key">Side</span>
                                <strong className={executeTicket.side === 'BUY' ? 'wr-ticket__side--buy' : 'wr-ticket__side--sell'}>{executeTicket.side}</strong>
                            </div>
                            <div className="wr-ticket__row">
                                <span className="wr-ticket__key">Paper Trade Price</span>
                                <strong>${executeTicket.price?.toFixed(2) ?? 'N/A'} {executeTicket.source ? `(${executeTicket.source})` : ''}</strong>
                            </div>
                        </div>
                        <label className="wr-qty">
                            QUANTITY
                            <input
                                className="q-input wr-input wr-num"
                                type="number"
                                value={executeQuantity}
                                min="0.01"
                                max={executeTicket.side === 'SELL' && executeMaxQuantity != null ? executeMaxQuantity : undefined}
                                step="0.01"
                                onChange={(event) => setExecuteQuantity(event.target.value)}
                            />
                            {executeTicket.side === 'SELL' && (
                                <span className={`wr-qty__hint${executeError ? ' wr-qty__hint--error' : ''}`}>
                                    {executeMaxQuantity != null ? `Available: ${executeMaxQuantity}` : 'Checking open position...'}
                                </span>
                            )}
                        </label>
                        {executeError && (
                            <div className="wr-error">
                                {executeError}
                            </div>
                        )}
                        <div className="wr-modal__actions">
                            <button className="q-btn wr-btn" onClick={() => setExecuteTicket(null)} disabled={isExecutingTrade}>
                                CANCEL
                            </button>
                            <button className="q-btn wr-btn wr-btn--primary" onClick={() => void submitExecuteStrategy()} disabled={isExecutingTrade || Boolean(executeError) || !executeTicket.price}>
                                {isExecutingTrade ? 'LOGGING...' : 'LOG PAPER TRADE'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default WarRoomPage;
