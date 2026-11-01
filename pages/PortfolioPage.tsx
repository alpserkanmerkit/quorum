import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { usePortfolioStore } from '../stores/portfolioStore';
import type { PortfolioStateModel, Position } from '../stores/portfolioStore';
import type { PortfolioRiskResponse } from '../types';
import apiClient, { getApiErrorMessage } from '../utils/apiClient';
import PortfolioPriceChart from '../components/PortfolioPriceChart';
import '../styles/portfolio.css';

const fmtAbs = (value: number) =>
    value >= 1_000_000_000 ? `$${(value / 1_000_000_000).toFixed(2)}B`
        : value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(1)}M`
            : `$${value.toLocaleString()}`;

// Sign goes in front of the currency symbol: -$1,890 rather than $-1,890.
const fmt = (value: number) => (value < 0 ? `-${fmtAbs(-value)}` : fmtAbs(value));

// Direction is never colour alone: a triangle (decorative, the sign is in the text) travels with every up/down figure.
const Mark: React.FC<{ value: number; after?: boolean }> = ({ value, after = false }) => (
    <span aria-hidden="true" className={`pf-mark${after ? ' pf-mark--after' : ''}`}>
        {value > 0 ? '\u25B2' : value < 0 ? '\u25BC' : '\u2013'}
    </span>
);
const dirClass = (value: number) => (value >= 0 ? 'pf-up' : 'pf-down');

export interface PriceTick {
    symbol: string;
    name: string;
    price: number;
    change24h: number;
    changePercent24h: number;
    updatedAt: number;
    source: string;
    freshnessStatus?: 'fresh' | 'stale' | 'unknown';
}

interface ChartPoint {
    symbol?: string;
    price: number;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close?: number | null;
    volume?: number | null;
    timestamp: number;
    source?: string;
    providerPolicy?: string;
    interval?: string;
}

type PriceTimeframe = '3M' | '6M' | '12M' | '24M';
export type HistoryStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
type HistoryQuality = {
    status: HistoryStatus;
    observations: number;
    source?: string;
    error?: string;
};

type LivePosition = Position & {
    liveTick?: PriceTick;
    livePrice: number;
    holdingPnL: number;
    pnlPct: number;
};

interface StrategyTicketState {
    strategyTicket?: {
        ticker: string;
        side: 'BUY' | 'SELL';
        quantity?: number;
        price?: number;
        source?: string;
    };
}

const PRICE_POLL_INTERVAL_MS = 15 * 1000;
const HISTORY_POINT_LIMIT = 48;
const PRICE_TIMEFRAMES: PriceTimeframe[] = ['24M', '12M', '6M', '3M'];

export function isLivePriceSource(source?: string): boolean {
    const normalized = source?.toLowerCase() ?? '';
    return Boolean(normalized && normalized !== 'simulated' && normalized !== 'persisted' && !normalized.startsWith('stale:'));
}

export function isStalePriceSource(source?: string): boolean {
    return Boolean(source?.toLowerCase().startsWith('stale:'));
}

export function isUsablePriceSource(source?: string): boolean {
    return isLivePriceSource(source) || isStalePriceSource(source);
}

export function getExecutionPriceForPosition(position: Pick<Position, 'currentPrice' | 'averagePrice'> & { livePrice?: number }): number {
    return position.livePrice && position.livePrice > 0
        ? position.livePrice
        : position.currentPrice > 0
            ? position.currentPrice
            : position.averagePrice;
}

export function isSellQuantityWithinPosition(quantity: number, positionQuantity?: number): boolean {
    return Boolean(positionQuantity && quantity > 0 && quantity <= positionQuantity + Number.EPSILON);
}

export const mergeChartHistory = (current: ChartPoint[], incoming: ChartPoint[], limit = HISTORY_POINT_LIMIT) => {
    const byKey = new Map<string, ChartPoint>();
    for (const point of [...current, ...incoming]) {
        if (!isUsablePriceSource(point.source)) continue;
        byKey.set(`${point.timestamp}:${point.price}:${point.source ?? ''}`, point);
    }

    const merged = Array.from(byKey.values())
        .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp);

    return limit > 0 ? merged.slice(-limit) : merged;
};

export function deriveLivePortfolioMetrics(portfolio: PortfolioStateModel, prices: PriceTick[]) {
    const usablePrices = prices.filter((tick) => Number.isFinite(tick.price) && tick.price > 0 && isUsablePriceSource(tick.source));
    const priceBySymbol = new Map(usablePrices.map((tick) => [tick.symbol.toUpperCase(), tick]));
    const livePositions: LivePosition[] = portfolio.positions.map((position) => {
        const liveTick = priceBySymbol.get(position.ticker.toUpperCase());
        const livePrice = liveTick?.price ?? position.currentPrice;
        const holdingPnL = (livePrice - position.averagePrice) * position.quantity;
        const pnlPct = position.averagePrice > 0 ? ((livePrice - position.averagePrice) / position.averagePrice) * 100 : 0;
        return { ...position, liveTick, livePrice, holdingPnL, pnlPct };
    });
    const liveMarketValue = livePositions.reduce((total, position) => total + position.livePrice * position.quantity, 0);
    const liveCost = livePositions.reduce((total, position) => total + position.averagePrice * position.quantity, 0);
    const livePnL = liveMarketValue - liveCost;
    const livePnlPercent = liveCost > 0 ? (livePnL / liveCost) * 100 : 0;
    const liveEquity = portfolio.cashBalance + liveMarketValue;

    return { priceBySymbol, livePositions, liveMarketValue, liveCost, livePnL, livePnlPercent, liveEquity };
}

const formatChartDate = (timestamp: number, timeframe: PriceTimeframe) =>
    new Date(timestamp).toLocaleDateString([], timeframe === '24M' || timeframe === '12M'
        ? { month: 'short', year: '2-digit' }
        : { month: 'short', day: 'numeric' });

const formatPct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

const formatPriceSourceLabel = (source?: string) => {
    if (!source) return 'Provider unavailable';
    return source.toLowerCase().startsWith('stale:') ? `Stale ${source.slice('stale:'.length)}` : source;
};

export function isQuoteCompatibleWithHistory(price: number, history: ChartPoint[]): boolean {
    if (!Number.isFinite(price) || price <= 0 || history.length < 2) return true;
    const lastPoint = history[history.length - 1];
    const lastPrice = Number(lastPoint.close ?? lastPoint.price);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return true;
    const ratio = price / lastPrice;
    return ratio >= 0.7 && ratio <= 1.3;
}

export const shouldShowTimeframeReturn = (status: HistoryStatus, points: ChartPoint[]) =>
    status === 'ready' && points.length > 1;

const PortfolioPage: React.FC = () => {
    const location = useLocation();
    const initialStrategyTicket = (location.state as StrategyTicketState | null)?.strategyTicket;
    const { portfolio, isLoading, isTrading, error, fetchPortfolio, tradeStock } = usePortfolioStore();
    const [tradeType, setTradeType] = useState<'BUY' | 'SELL'>(initialStrategyTicket?.side ?? 'BUY');
    const [ticker, setTicker] = useState(initialStrategyTicket?.ticker.toUpperCase() ?? '');
    const [quantity, setQuantity] = useState(initialStrategyTicket?.quantity ? String(initialStrategyTicket.quantity) : '');
    const [price, setPrice] = useState(initialStrategyTicket?.price ? String(initialStrategyTicket.price) : '');
    const [priceTouched, setPriceTouched] = useState(Boolean(initialStrategyTicket?.price));
    const [prices, setPrices] = useState<PriceTick[]>([]);
    const [priceHistory, setPriceHistory] = useState<Record<string, ChartPoint[]>>({});
    const [historyStatusBySymbol, setHistoryStatusBySymbol] = useState<Record<string, HistoryStatus>>({});
    const [historyQualityBySymbol, setHistoryQualityBySymbol] = useState<Record<string, HistoryQuality>>({});
    const [selectedTimeframe, setSelectedTimeframe] = useState<PriceTimeframe>('24M');
    const [selectedTicker, setSelectedTicker] = useState<string>(initialStrategyTicket?.ticker.toUpperCase() ?? '');
    const [priceFeedStatus, setPriceFeedStatus] = useState<'loading' | 'live' | 'delayed'>('loading');
    const [priceFeedMessage, setPriceFeedMessage] = useState('Connecting to live price feed...');
    const [risk, setRisk] = useState<PortfolioRiskResponse | null>(null);
    const [riskError, setRiskError] = useState<string | null>(null);
    const [riskLoading, setRiskLoading] = useState(false);
    const portfolioSymbols = portfolio?.positions.map((position) => position.ticker.toUpperCase()).sort().join(',') ?? '';

    useEffect(() => {
        void fetchPortfolio();
    }, [fetchPortfolio]);

    useEffect(() => {
        let cancelled = false;

        const fetchPrices = async () => {
            try {
                const response = await apiClient.get('/api/news/prices', {
                    params: portfolioSymbols ? { symbols: portfolioSymbols } : undefined,
                });
                const nextPrices = (response.data.prices ?? []) as PriceTick[];
                if (cancelled) return;

                setPrices(nextPrices);
                const hasLivePrices = nextPrices.some((tick) => isLivePriceSource(tick.source));
                const hasStalePrices = nextPrices.some((tick) => isStalePriceSource(tick.source));
                setPriceFeedStatus(hasLivePrices ? 'live' : 'delayed');
                setPriceFeedMessage(hasLivePrices
                    ? 'Live price feed connected'
                    : hasStalePrices
                        ? 'Live quotes delayed. Using stale provider cache.'
                        : 'Live quotes unavailable. No simulated prices are shown.');
            } catch (fetchError) {
                if (cancelled) return;
                setPriceFeedStatus('delayed');
                setPriceFeedMessage(getApiErrorMessage(fetchError, 'Live price feed delayed. Using last known prices.'));
            }
        };

        void fetchPrices();
        const interval = window.setInterval(fetchPrices, PRICE_POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [portfolioSymbols]);

    useEffect(() => {
        if (!portfolioSymbols) {
            setHistoryStatusBySymbol({});
            setHistoryQualityBySymbol({});
            return;
        }
        let cancelled = false;
        const requestedSymbols = portfolioSymbols.split(',').filter(Boolean);

        const fetchHistory = async () => {
            setHistoryStatusBySymbol((current) => {
                const next = { ...current };
                for (const symbol of requestedSymbols) {
                    next[symbol] = 'loading';
                }
                return next;
            });
            try {
                const response = await apiClient.get('/api/news/prices/history', {
                    params: { symbols: portfolioSymbols, range: selectedTimeframe },
                });
                const history = (response.data.history ?? {}) as Record<string, ChartPoint[]>;
                const errors = (response.data.errors ?? response.data.dataQuality?.errors ?? {}) as Record<string, string>;
                const historySource = response.data.dataQuality?.source as string | undefined;
                if (cancelled) return;

                setPriceHistory((current) => {
                    const next = { ...current };
                    for (const [symbol, points] of Object.entries(history)) {
                        next[symbol.toUpperCase()] = points
                            .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp))
                            .sort((a, b) => a.timestamp - b.timestamp);
                    }
                    return next;
                });
                setHistoryStatusBySymbol((current) => {
                    const next = { ...current };
                    for (const symbol of requestedSymbols) {
                        const points = history[symbol] ?? history[symbol.toUpperCase()] ?? [];
                        const validPointCount = points.filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp)).length;
                        next[symbol] = validPointCount > 1 ? 'ready' : errors[symbol] ? 'error' : 'empty';
                    }
                    return next;
                });
                setHistoryQualityBySymbol((current) => {
                    const next = { ...current };
                    for (const symbol of requestedSymbols) {
                        const points = history[symbol] ?? history[symbol.toUpperCase()] ?? [];
                        const validPointCount = points.filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp)).length;
                        next[symbol] = {
                            status: validPointCount > 1 ? 'ready' : errors[symbol] ? 'error' : 'empty',
                            observations: validPointCount,
                            source: historySource ?? points[0]?.source,
                            error: errors[symbol],
                        };
                    }
                    return next;
                });
            } catch (fetchError) {
                if (cancelled) return;
                setHistoryStatusBySymbol((current) => {
                    const next = { ...current };
                    for (const symbol of requestedSymbols) {
                        next[symbol] = 'error';
                    }
                    return next;
                });
                setHistoryQualityBySymbol((current) => {
                    const next = { ...current };
                    for (const symbol of requestedSymbols) {
                        next[symbol] = {
                            status: 'error',
                            observations: 0,
                            error: getApiErrorMessage(fetchError, 'History unavailable'),
                        };
                    }
                    return next;
                });
                console.warn('[Portfolio] Historical tape delayed:', getApiErrorMessage(fetchError, 'History unavailable'));
            }
        };

        void fetchHistory();
        return () => {
            cancelled = true;
        };
    }, [portfolioSymbols, selectedTimeframe]);

    useEffect(() => {
        if (!portfolioSymbols) {
            setRisk(null);
            return;
        }
        let cancelled = false;

        const fetchRisk = async () => {
            setRiskLoading(true);
            setRiskError(null);
            try {
                const response = await apiClient.get('/api/portfolio/risk', {
                    params: { range: selectedTimeframe, confidence: 95, horizonDays: 1 },
                });
                if (!cancelled) {
                    setRisk(response.data.risk);
                }
            } catch (fetchError) {
                if (!cancelled) {
                    setRiskError(getApiErrorMessage(fetchError, 'Portfolio risk is temporarily unavailable.'));
                }
            } finally {
                if (!cancelled) {
                    setRiskLoading(false);
                }
            }
        };

        void fetchRisk();
        return () => {
            cancelled = true;
        };
    }, [portfolioSymbols, selectedTimeframe]);

    if (isLoading && !portfolio) {
        return <div className="q-empty"><p>Loading portfolio...</p></div>;
    }

    if (!portfolio) {
        return (
            <div className="q-empty">
                <p>{error || 'No portfolio data available. Check database setup and authentication.'}</p>
            </div>
        );
    }

    const { priceBySymbol, livePositions, livePnL, livePnlPercent, liveEquity } = deriveLivePortfolioMetrics(portfolio, prices);
    const effectiveSelectedTicker = selectedTicker || livePositions[0]?.ticker || '';
    const activePosition = livePositions.find((position) => position.ticker === effectiveSelectedTicker) ?? livePositions[0];
    const activeTick = activePosition?.liveTick;
    const activeTickIsLive = isLivePriceSource(activeTick?.source);
    const activeTickIsStale = isStalePriceSource(activeTick?.source);
    const activeHistoryStatus = activePosition ? historyStatusBySymbol[activePosition.ticker.toUpperCase()] ?? 'idle' : 'idle';
    const activeHistoryQuality = activePosition ? historyQualityBySymbol[activePosition.ticker.toUpperCase()] : undefined;
    const activeRangeHistory = activePosition ? priceHistory[activePosition.ticker.toUpperCase()] ?? [] : [];
    const activeTickPoint = activeTick && isUsablePriceSource(activeTick.source) && isQuoteCompatibleWithHistory(activeTick.price, activeRangeHistory)
        ? [{
            price: activeTick.price,
            timestamp: activeTick.updatedAt,
            source: activeTick.source,
            open: activeTick.price,
            high: activeTick.price,
            low: activeTick.price,
            close: activeTick.price,
        }]
        : [];
    const activeHistory = activePosition
        ? mergeChartHistory(
            activeRangeHistory,
            activeTickPoint,
            0
        )
        : [];
    const activeHistoryStats = activeHistory.length > 0
        ? {
            min: Math.min(...activeHistory.map((point) => point.price)),
            max: Math.max(...activeHistory.map((point) => point.price)),
            last: activeHistory[activeHistory.length - 1].price,
            first: activeHistory[0].price,
        }
        : null;
    const hasReadyRangeHistory = shouldShowTimeframeReturn(activeHistoryStatus, activeHistory);
    const timeframeReturn = activeHistoryStats && activeHistoryStats.first > 0
        ? ((activeHistoryStats.last - activeHistoryStats.first) / activeHistoryStats.first) * 100
        : 0;
    const xAxisLabels = activeHistory.length > 1
        ? [activeHistory[0], activeHistory[Math.floor(activeHistory.length / 2)], activeHistory[activeHistory.length - 1]]
        : [];
    const activeObservationCount = activeHistoryQuality?.observations ?? activeRangeHistory.length;
    const activeHistorySource = activeHistoryQuality?.source ?? activeRangeHistory[0]?.source ?? activeTick?.source ?? 'Market';
    const activeMarketLabel = activeTickIsLive ? 'LIVE' : activeTickIsStale ? 'STALE' : 'UNAVAILABLE';
    const historyStatusLabel = activeHistoryStatus === 'ready'
        ? 'READY'
        : activeHistoryStatus === 'loading'
            ? 'LOADING'
            : activeHistoryStatus === 'error'
                ? 'DELAYED'
                : activeHistoryStatus === 'empty'
                    ? 'EMPTY'
                    : 'STANDBY';
    const historyStatusClass = activeHistoryStatus === 'ready'
        ? 'q-badge--bull'
        : activeHistoryStatus === 'loading'
            ? 'q-badge--neutral'
            : 'q-badge--warn';
    const currentTradeSymbol = ticker.trim().toUpperCase();
    const currentTradePosition = livePositions.find((position) => position.ticker.toUpperCase() === currentTradeSymbol);
    const suggestedExecutionPrice = currentTradeSymbol ? priceBySymbol.get(currentTradeSymbol)?.price : undefined;
    const displayedExecutionPrice = price || (!priceTouched && suggestedExecutionPrice ? String(suggestedExecutionPrice) : '');
    const requestedSellQuantity = Number.parseFloat(quantity);
    const sellHasPosition = tradeType !== 'SELL' || Boolean(currentTradePosition);
    const sellQuantityValid = tradeType !== 'SELL' || isSellQuantityWithinPosition(requestedSellQuantity, currentTradePosition?.quantity);
    const canSubmitTrade = !isTrading && sellHasPosition && sellQuantityValid;

    const getSuggestedPriceForTicker = (symbol: string) =>
        prices.find((tick) => tick.symbol.toUpperCase() === symbol.trim().toUpperCase())?.price;

    const prefillSellTicket = (position: LivePosition) => {
        setSelectedTicker(position.ticker);
        setTradeType('SELL');
        setTicker(position.ticker);
        setQuantity(String(position.quantity));
        setPrice(String(getExecutionPriceForPosition(position)));
        setPriceTouched(true);
    };

    const handleTrade = async (event: React.FormEvent) => {
        event.preventDefault();
        const qty = Number.parseFloat(quantity);
        const suggestedPrice = !priceTouched ? getSuggestedPriceForTicker(ticker) : undefined;
        const fallbackPrice = tradeType === 'SELL' && currentTradePosition ? getExecutionPriceForPosition(currentTradePosition) : undefined;
        const executionPrice = Number.parseFloat(price || String(suggestedPrice ?? fallbackPrice ?? ''));
        if (qty > 0 && executionPrice > 0 && ticker.trim() && canSubmitTrade) {
            const success = await tradeStock(ticker.toUpperCase(), tradeType, qty, executionPrice);
            if (success) {
                setTicker('');
                setQuantity('');
                setPrice('');
                setPriceTouched(false);
            }
        }
    };

    const marketStatusClass = activeTickIsLive ? 'pf-up' : activeTickIsStale ? 'pf-warn' : 'pf-muted';
    const feedDotClass = activeTickIsLive ? 'pf-dot--live' : activeTickIsStale || priceFeedStatus === 'delayed' ? 'pf-dot--warn' : '';

    // Plain-language reading of the numbers above; every figure is derived from values already on this page.
    const cashSharePct = liveEquity > 0 ? (portfolio.cashBalance / liveEquity) * 100 : null;
    const largestHolding = risk?.concentration.length
        ? risk.concentration.reduce((top, item) => (item.weight > top.weight ? item : top))
        : null;
    const heavyHoldings = risk?.concentration.filter((item) => item.weight > 0.2) ?? [];
    const worstScenario = risk?.scenarios.length
        ? risk.scenarios.reduce((worst, item) => (item.portfolioImpact < worst.portfolioImpact ? item : worst))
        : null;

    return (
        <div className="pf">
            <header className="q-page-header">
                <div>
                    <h2 className="q-page-title pf-title">Live Portfolio</h2>
                    <p className="q-page-sub">{portfolio.positions.length} positions - Price sync enabled</p>
                </div>
                <div className="q-header-actions">
                    <button onClick={() => void fetchPortfolio()} className="q-btn q-btn--ghost q-btn--sm" disabled={isLoading}>
                        <RefreshCw size={13} className={isLoading ? 'pf-spin' : undefined} /> Refresh
                    </button>
                </div>
            </header>

            <div className="q-scroll-area">
                <div className="pf-wrap">
                <div className="q-stat-grid pf-stats">
                    <div className="q-stat-tile">
                        <span className="q-stat-label">Total Balance</span>
                        <span className="q-stat-value q-stat-value--gold">{fmt(liveEquity)}</span>
                        <span className="pf-hint-line">Cash plus the current value of your priced holdings.</span>
                    </div>
                    <div className="q-stat-tile">
                        <span className="q-stat-label">Cash Available</span>
                        <span className="q-stat-value q-stat-value--neutral">{fmt(portfolio.cashBalance)}</span>
                        {cashSharePct !== null && (
                            <span className="pf-hint-line">{cashSharePct.toFixed(1)}% of your total balance is uninvested cash.</span>
                        )}
                    </div>
                    <div className="q-stat-tile">
                        <span className="q-stat-label">Unrealized P&amp;L</span>
                        <span className={`q-stat-value ${livePnL >= 0 ? 'q-stat-value--bull' : 'q-stat-value--bear'}`}>
                            {livePnL >= 0 ? '+' : ''}{fmt(livePnL)}
                        </span>
                        <span className={`q-stat-change ${livePnlPercent >= 0 ? 'q-stat-change--pos' : 'q-stat-change--neg'}`}>
                            <Mark value={livePnlPercent} />
                            {livePnlPercent >= 0 ? '+' : ''}{livePnlPercent.toFixed(2)}%
                        </span>
                        <span className="pf-hint-line">Gain or loss on open positions versus the average price you paid.</span>
                    </div>
                </div>

                <div className="pf-block pf-row">
                    <div className="pf-row__main">
                    <div className="q-card pf-report" data-testid="portfolio-live-chart">
                        <div className="pf-report-head pf-report-head--quote">
                            <div style={{ minWidth: 0 }}>
                                <p className="pf-label">Price tape</p>
                                <h3 className="pf-h3">
                                    {activePosition ? activePosition.ticker : 'NO POSITION'}
                                    {activePosition && (
                                        <span className={`pf-status ${marketStatusClass}`} style={{ marginLeft: 12 }}>
                                            {activeMarketLabel}
                                        </span>
                                    )}
                                </h3>
                                {activePosition && (
                                    <p className="pf-deck">
                                        You hold {activePosition.quantity.toLocaleString()} at an average price of ${activePosition.averagePrice.toFixed(2)};
                                        the latest price is ${activePosition.livePrice.toFixed(2)}, so this position is {activePosition.pnlPct >= 0 ? 'up' : 'down'} {Math.abs(activePosition.pnlPct).toFixed(2)}% since purchase.
                                    </p>
                                )}
                            </div>
                            <div className="pf-quote">
                                <div className="pf-feed">
                                    <span className={`pf-dot ${feedDotClass}`} />
                                    <span>
                                        {activeTick ? `${formatPriceSourceLabel(activeTick.source)} ${new Date(activeTick.updatedAt).toLocaleTimeString()}` : priceFeedMessage}
                                    </span>
                                </div>
                                {activePosition && (
                                    <>
                                        <p className={`pf-quote-price ${dirClass(activeTick?.changePercent24h ?? 0)}`}>
                                            ${activePosition.livePrice.toFixed(2)}
                                            <span className="pf-quote-pct">
                                                <Mark value={activeTick?.changePercent24h ?? 0} />
                                                {formatPct(activeTick?.changePercent24h ?? 0)}
                                            </span>
                                        </p>
                                        <p className={`pf-quote-line ${dirClass(activePosition.pnlPct)}`}>
                                            Holding P&amp;L {formatPct(activePosition.pnlPct)}
                                            <Mark value={activePosition.pnlPct} after />
                                        </p>
                                    </>
                                )}
                            </div>
                        </div>
                        <div className="pf-toolbar">
                            <div className="pf-toolbar-group">
                                {PRICE_TIMEFRAMES.map((timeframe) => (
                                    <button
                                        key={timeframe}
                                        type="button"
                                        data-testid={`portfolio-timeframe-${timeframe}`}
                                        aria-pressed={selectedTimeframe === timeframe}
                                        onClick={() => setSelectedTimeframe(timeframe)}
                                        className="q-btn q-btn--sm pf-tf"
                                    >
                                        {timeframe}
                                    </button>
                                ))}
                            </div>
                            <div className="pf-toolbar-group" style={{ justifyContent: 'flex-end' }}>
                                <span data-testid="portfolio-history-status" className={`q-badge ${historyStatusClass}`}>
                                    {historyStatusLabel} - {activeObservationCount} OBS
                                </span>
                                <span className="q-badge q-badge--neutral">
                                    {formatPriceSourceLabel(activeHistorySource)}
                                </span>
                                {hasReadyRangeHistory ? (
                                    <span className={`pf-num ${dirClass(timeframeReturn)}`} style={{ fontSize: 12 }}>
                                        {selectedTimeframe} return {formatPct(timeframeReturn)}
                                        <Mark value={timeframeReturn} after />
                                    </span>
                                ) : activePosition ? (
                                    <span className="pf-num pf-muted" style={{ fontSize: 12 }}>
                                        {selectedTimeframe} return unavailable
                                    </span>
                                ) : null}
                            </div>
                        </div>
                        <div className="pf-plate">
                            {activePosition ? (
                                <div className="pf-plate-grid">
                                    <dl className="pf-hl">
                                        <div className="pf-hl-row"><dt>H</dt><dd>{activeHistoryStats ? `$${activeHistoryStats.max.toFixed(2)}` : 'N/A'}</dd></div>
                                        <div className="pf-hl-row"><dt>L</dt><dd>{activeHistoryStats ? `$${activeHistoryStats.min.toFixed(2)}` : 'N/A'}</dd></div>
                                        <div className="pf-hl-row"><dt>Last</dt><dd>{activeHistoryStats ? `$${activeHistoryStats.last.toFixed(2)}` : 'N/A'}</dd></div>
                                    </dl>
                                    <div className="pf-plate-body">
                                        {!hasReadyRangeHistory && (
                                            <div data-testid="portfolio-history-collecting" className={`pf-collecting${activeHistoryStatus === 'error' ? ' pf-collecting--warn' : ''}`}>
                                                {activeHistoryStatus === 'error'
                                                    ? 'Historical tape delayed'
                                                    : activeHistoryStatus === 'empty'
                                                        ? 'Historical tape unavailable'
                                                        : 'Collecting historical tape'}
                                            </div>
                                        )}
                                        <PortfolioPriceChart points={activeHistory} isPositive={timeframeReturn >= 0} height={260} />
                                        <div className="pf-axis">
                                            {hasReadyRangeHistory && xAxisLabels.length > 0 ? xAxisLabels.map((point, index) => (
                                                <span key={`${point.timestamp}-${index}`}>{formatChartDate(point.timestamp, selectedTimeframe)}</span>
                                            )) : <span>Waiting for history</span>}
                                        </div>
                                        {activeHistoryQuality?.error && (
                                            <p className="pf-note">{activeHistoryQuality.error}</p>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                <div className="pf-empty-plate">
                                    Record a paper trade to open the live tape.
                                </div>
                            )}
                        </div>
                        {priceFeedStatus === 'delayed' && (
                            <p className="pf-note">{priceFeedMessage}</p>
                        )}
                    </div>
                    </div>
                    <aside className="pf-row__aside" aria-label="Current positions">
                            <h3 className="pf-h4">Current positions</h3>
                            <div className="q-table-wrap">
                                <table className="q-table">
                                    <thead>
                                        <tr>
                                            <th>Ticker</th>
                                            <th className="pf-r">Qty</th>
                                            <th className="pf-r">Avg price</th>
                                            <th className="pf-r">Current</th>
                                            <th className="pf-r">P&amp;L</th>
                                            <th className="pf-r">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {livePositions.map((position) => (
                                            <tr
                                                key={position.id}
                                                onClick={() => prefillSellTicket(position)}
                                                className={`pf-row--clickable${effectiveSelectedTicker === position.ticker ? ' pf-row--active' : ''}`}
                                            >
                                                <td className="pf-ticker">{position.ticker}</td>
                                                <td className="pf-r">{position.quantity.toLocaleString()}</td>
                                                <td className="pf-r">${position.averagePrice.toFixed(2)}</td>
                                                <td className="pf-r">
                                                    ${position.livePrice.toFixed(2)} {position.liveTick && (
                                                        <span className={`pf-tag ${isLivePriceSource(position.liveTick.source) ? 'pf-up' : 'pf-warn'}`}>
                                                            {isLivePriceSource(position.liveTick.source) ? 'LIVE' : 'STALE'}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className={`pf-r ${dirClass(position.pnlPct)}`}>
                                                    <Mark value={position.pnlPct} />{position.pnlPct >= 0 ? '+' : ''}{position.pnlPct.toFixed(1)}%
                                                    <span className="pf-sub">
                                                        {position.holdingPnL >= 0 ? '+' : ''}{fmt(position.holdingPnL)}
                                                    </span>
                                                </td>
                                                <td className="pf-r">
                                                    <button
                                                        type="button"
                                                        className="q-btn q-btn--ghost q-btn--sm pf-sell"
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            prefillSellTicket(position);
                                                        }}
                                                    >
                                                        Sell
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                        {portfolio.positions.length === 0 && (
                                            <tr>
                                                <td colSpan={6} className="pf-empty-cell">
                                                    No open positions. Use the Paper Trade Terminal to record a simulated trade.
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </aside>
                </div>

                <div className="pf-block">
                    <div className="q-card pf-report" data-testid="portfolio-risk-panel">
                        <div className="pf-report-head">
                            <div>
                                <p className="pf-label">Risk report</p>
                                <h3 className="pf-h3">Portfolio Risk</h3>
                                <p className="pf-deck">
                                    VaR, stress scenarios, concentration and correlation over {selectedTimeframe}
                                </p>
                            </div>
                            {risk?.dataQuality && (
                                <span className={`q-badge ${risk.dataQuality.status === 'ready' ? 'q-badge--bull' : 'q-badge--warn'}`}>
                                    {risk.dataQuality.status.toUpperCase()} · {risk.dataQuality.observations} OBS
                                </span>
                            )}
                        </div>

                        {riskLoading && <p className="pf-status-line">Calculating institutional risk...</p>}
                        {riskError && <p className="pf-status-line pf-status-line--bad">{riskError}</p>}
                        {!riskLoading && risk?.metrics && (
                            <>
                                <div className="q-stat-grid pf-report-stats">
                                    <div className="q-stat-tile">
                                        <span className="q-stat-label">Historical VaR 95%</span>
                                        <span className="q-stat-value q-stat-value--bear">{fmt(risk.metrics.historicalVaR)}</span>
                                        <span className="q-stat-change q-stat-change--neg"><Mark value={-1} />-{risk.metrics.historicalVaRPercent.toFixed(2)}%</span>
                                    </div>
                                    <div className="q-stat-tile">
                                        <span className="q-stat-label">Expected Shortfall</span>
                                        <span className="q-stat-value q-stat-value--warn">{fmt(risk.metrics.expectedShortfall)}</span>
                                        <span className="q-stat-change q-stat-change--neg"><Mark value={-1} />-{risk.metrics.expectedShortfallPercent.toFixed(2)}%</span>
                                    </div>
                                    <div className="q-stat-tile">
                                        <span className="q-stat-label">Monte Carlo VaR</span>
                                        <span className="q-stat-value q-stat-value--neutral">{fmt(risk.metrics.monteCarloVaR)}</span>
                                        <span className="q-stat-change">{risk.metrics.monteCarloVaRPercent.toFixed(2)}%</span>
                                    </div>
                                    <div className="q-stat-tile">
                                        <span className="q-stat-label">Annualized Vol</span>
                                        <span className="q-stat-value q-stat-value--gold">{risk.metrics.annualizedVolatility.toFixed(2)}%</span>
                                    </div>
                                </div>

                                <div className="pf-plain">
                                    <h4 className="pf-h4">In plain terms</h4>
                                    <ul>
                                        <li>
                                            On 1 trading day in 20, the portfolio could lose about {fmt(risk.metrics.historicalVaR)} ({risk.metrics.historicalVaRPercent.toFixed(2)}% of its value) or more, judged by the last {selectedTimeframe} of price history.
                                        </li>
                                        <li>
                                            On those worst days the average loss is about {fmt(risk.metrics.expectedShortfall)} ({risk.metrics.expectedShortfallPercent.toFixed(2)}%).
                                        </li>
                                        <li>
                                            Prices have swung about {risk.metrics.annualizedVolatility.toFixed(2)}% a year; the higher this is, the bumpier the ride.
                                        </li>
                                        {largestHolding && (
                                            <li>
                                                {largestHolding.ticker} is your largest holding at {(largestHolding.weight * 100).toFixed(1)}% of priced value
                                                {heavyHoldings.length > 0
                                                    ? `; ${heavyHoldings.length} holding${heavyHoldings.length === 1 ? ' is' : 's are'} above 20%, so one stock can move the whole portfolio.`
                                                    : '; none is above 20%, so no single stock dominates.'}
                                            </li>
                                        )}
                                        {worstScenario && (
                                            <li>
                                                The harshest stress test is {worstScenario.name}: about {fmt(worstScenario.portfolioImpact)} ({formatPct(worstScenario.portfolioImpactPercent)}).
                                            </li>
                                        )}
                                    </ul>
                                </div>

                                <div className="pf-risk-split">
                                    <div className="pf-sub-report">
                                        <h4 className="pf-h4">Stress tests</h4>
                                        <div className="q-table-wrap">
                                            <table className="q-table">
                                                <thead>
                                                    <tr>
                                                        <th>Scenario</th>
                                                        <th className="pf-r">Impact</th>
                                                        <th className="pf-r">Impact %</th>
                                                        <th className="pf-r">VaR after</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {risk.scenarios.map((scenario) => (
                                                        <tr key={scenario.id}>
                                                            <td className="pf-text">{scenario.name}</td>
                                                            <td className={`pf-r ${dirClass(scenario.portfolioImpact)}`}><Mark value={scenario.portfolioImpact} />{fmt(scenario.portfolioImpact)}</td>
                                                            <td className={`pf-r ${dirClass(scenario.portfolioImpactPercent)}`}><Mark value={scenario.portfolioImpactPercent} />{formatPct(scenario.portfolioImpactPercent)}</td>
                                                            <td className="pf-r">{fmt(scenario.varAfter)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                    <div className="pf-sub-report">
                                        <h4 className="pf-h4">Concentration</h4>
                                        <ul className="pf-conc">
                                            {risk.concentration.slice(0, 5).map((item) => (
                                                <li key={item.ticker}>
                                                    <div className="pf-conc-head">
                                                        <span>{item.ticker}</span>
                                                        <span>{(item.weight * 100).toFixed(1)}%</span>
                                                    </div>
                                                    <div className="pf-bar">
                                                        <div className={`pf-bar-fill${item.weight > 0.2 ? ' pf-bar-fill--over' : ''}`} style={{ width: `${Math.min(item.weight * 100, 100)}%` }} />
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                        {risk.dataQuality.missingSymbols.length > 0 && (
                                            <p className="pf-note">
                                                Limited history: {risk.dataQuality.missingSymbols.join(', ')}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                <div className="pf-split">
                    <div className="pf-tables">
                        <div>
                            <h3 className="pf-h4">Recent transactions</h3>
                            <div className="q-table-wrap">
                                <table className="q-table">
                                    <thead>
                                        <tr>
                                            <th>Time</th>
                                            <th>Ticker</th>
                                            <th>Type</th>
                                            <th className="pf-r">Qty</th>
                                            <th className="pf-r">Price</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {portfolio.transactions.map((transaction) => (
                                            <tr key={transaction.id}>
                                                <td style={{ fontSize: 12 }}>{new Date(transaction.timestamp).toLocaleString()}</td>
                                                <td className="pf-ticker">{transaction.ticker}</td>
                                                <td>{transaction.type}</td>
                                                <td className="pf-r">{transaction.quantity}</td>
                                                <td className="pf-r">${transaction.price.toFixed(2)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <div>
                        <h3 className="pf-h4">Paper trade terminal</h3>
                        <div className="q-card pf-ticket">
                            {error && (
                                <div className="pf-error" role="alert">
                                    <AlertCircle size={14} /> {error}
                                </div>
                            )}

                            <form onSubmit={handleTrade}>
                                <div className="pf-side">
                                    <button type="button" aria-pressed={tradeType === 'BUY'} onClick={() => setTradeType('BUY')}>
                                        <span aria-hidden="true" className="pf-mark">{'▲'}</span>BUY
                                    </button>
                                    <button type="button" aria-pressed={tradeType === 'SELL'} onClick={() => setTradeType('SELL')}>
                                        <span aria-hidden="true" className="pf-mark">{'▼'}</span>SELL
                                    </button>
                                </div>

                                <label className="pf-field">
                                    Ticker
                                    <input className="q-input" value={ticker} onChange={(event) => { setTicker(event.target.value.toUpperCase()); setPriceTouched(false); }} placeholder="e.g. AAPL" required style={{ textTransform: 'uppercase' }} />
                                </label>

                                <label className="pf-field">
                                    Quantity
                                    <input className="q-input" type="number" value={quantity} onChange={(event) => setQuantity(event.target.value)} min="0.01" max={tradeType === 'SELL' ? currentTradePosition?.quantity : undefined} step="0.01" required />
                                    {tradeType === 'SELL' && (
                                        <span className={`pf-hint${sellHasPosition && sellQuantityValid ? '' : ' pf-hint--bad'}`}>
                                            {currentTradePosition ? `Available: ${currentTradePosition.quantity}` : 'No open position to sell'}
                                        </span>
                                    )}
                                </label>

                                <label className="pf-field">
                                    Paper trade price
                                    <input className="q-input" type="number" value={displayedExecutionPrice} onChange={(event) => { setPrice(event.target.value); setPriceTouched(true); }} min="0.01" step="0.01" required />
                                    {currentTradeSymbol && priceBySymbol.get(currentTradeSymbol) && (
                                        <span className={`pf-hint ${isLivePriceSource(priceBySymbol.get(currentTradeSymbol)?.source) ? 'pf-hint--live' : 'pf-hint--stale'}`}>
                                            {isLivePriceSource(priceBySymbol.get(currentTradeSymbol)?.source) ? 'Live' : 'Stale'} suggestion from {priceBySymbol.get(currentTradeSymbol)?.source}
                                        </span>
                                    )}
                                </label>

                                <button type="submit" className="pf-submit" disabled={!canSubmitTrade}>
                                    {isTrading ? 'LOGGING...' : tradeType === 'SELL' ? 'LOG PAPER SELL' : 'LOG PAPER BUY'}
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
                <div className="pf-spacer" />
                </div>
            </div>
        </div>
    );
};

export default PortfolioPage;
