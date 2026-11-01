import React, { useEffect, useMemo, useRef } from 'react';
import {
    AreaSeries,
    CandlestickSeries,
    ColorType,
    createChart,
    HistogramSeries,
    type AreaData,
    type CandlestickData,
    type HistogramData,
    type IChartApi,
    type ISeriesApi,
    type Time,
    type UTCTimestamp,
} from 'lightweight-charts';

export interface PortfolioChartPoint {
    price: number;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close?: number | null;
    volume?: number | null;
    timestamp: number;
}

interface PortfolioPriceChartProps {
    points: PortfolioChartPoint[];
    height?: number;
    isPositive: boolean;
}

const toChartTime = (timestamp: number): Time => Math.floor(timestamp / 1000) as UTCTimestamp;

const isPositiveFinite = (value: unknown): value is number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0;
};

function normalizePoints(points: PortfolioChartPoint[]) {
    const byTime = new Map<number, PortfolioChartPoint>();
    for (const point of points) {
        if (!Number.isFinite(point.timestamp) || !isPositiveFinite(point.price)) continue;
        byTime.set(Math.floor(point.timestamp / 1000), point);
    }

    return Array.from(byTime.entries())
        .sort(([left], [right]) => left - right)
        .map(([, point]) => point);
}

function toCandles(points: PortfolioChartPoint[]): CandlestickData[] {
    return points
        .filter((point) =>
            isPositiveFinite(point.open)
            && isPositiveFinite(point.high)
            && isPositiveFinite(point.low)
            && isPositiveFinite(point.close ?? point.price)
        )
        .map((point) => ({
            time: toChartTime(point.timestamp),
            open: Number(point.open),
            high: Number(point.high),
            low: Number(point.low),
            close: Number(point.close ?? point.price),
        }));
}

function toArea(points: PortfolioChartPoint[]): AreaData[] {
    return points.map((point) => ({
        time: toChartTime(point.timestamp),
        value: Number(point.close ?? point.price),
    }));
}

// Chart colours come from the design tokens at run time (getComputedStyle on :root).
// The fallbacks are CSS keywords, used only when a token is not defined (e.g. a bare test DOM).
const TOKEN_FALLBACKS = {
    '--q-border': 'GrayText',
    '--q-border-bright': 'GrayText',
    '--q-text-secondary': 'GrayText',
    '--q-text-muted': 'GrayText',
    '--q-text-heading': 'CanvasText',
    '--q-accent': 'CanvasText',
    '--q-bg-base': 'Canvas',
    '--q-bg-elevated': 'Canvas',
    '--q-bull': 'green',
    '--q-bear': 'red',
    '--q-font-mono': 'ui-monospace, monospace',
} as const;

type TokenName = keyof typeof TOKEN_FALLBACKS;

const readToken = (name: TokenName): string => {
    if (typeof document === 'undefined') return TOKEN_FALLBACKS[name];
    try {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value || TOKEN_FALLBACKS[name];
    } catch {
        return TOKEN_FALLBACKS[name];
    }
};

/** Returns `color` with the given alpha; unparseable colours are returned unchanged. */
function withAlpha(color: string, alpha: number): string {
    const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        const digits = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    const rgb = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
    return color;
}

function readChartTheme() {
    return {
        grid: readToken('--q-border'),
        axis: readToken('--q-border-bright'),
        text: readToken('--q-text-secondary'),
        muted: readToken('--q-text-muted'),
        ink: readToken('--q-text-heading'),
        accent: readToken('--q-accent'),
        base: readToken('--q-bg-base'),
        elevated: readToken('--q-bg-elevated'),
        bull: readToken('--q-bull'),
        bear: readToken('--q-bear'),
        font: readToken('--q-font-mono'),
    };
}

type ChartTheme = ReturnType<typeof readChartTheme>;

function chartOptions(theme: ChartTheme) {
    return {
        layout: {
            background: { type: ColorType.Solid, color: 'transparent' },
            textColor: theme.text,
            fontFamily: theme.font,
            fontSize: 11,
        },
        grid: {
            vertLines: { color: theme.grid },
            horzLines: { color: theme.grid },
        },
        crosshair: {
            horzLine: { color: theme.muted, labelBackgroundColor: theme.elevated },
            vertLine: { color: theme.muted, labelBackgroundColor: theme.elevated },
        },
        rightPriceScale: { borderColor: theme.axis },
        timeScale: { borderColor: theme.axis },
    };
}

// Candles are not told apart by colour alone: up = hollow body, down = filled body.
const candleOptions = (theme: ChartTheme, isPositive: boolean) => ({
    upColor: theme.base,
    downColor: theme.bear,
    borderVisible: true,
    borderUpColor: theme.bull,
    borderDownColor: theme.bear,
    wickUpColor: theme.bull,
    wickDownColor: theme.bear,
    priceLineColor: isPositive ? theme.bull : theme.bear,
});

// Flat tint under the line (same alpha top and bottom): depth by tone, no gradient.
const areaOptions = (theme: ChartTheme, isPositive: boolean) => ({
    lineColor: theme.accent,
    topColor: withAlpha(theme.accent, 0.1),
    bottomColor: withAlpha(theme.accent, 0.1),
    priceLineColor: isPositive ? theme.bull : theme.bear,
});

function toVolume(points: PortfolioChartPoint[], theme: ChartTheme): HistogramData[] {
    return points
        .filter((point) => Number.isFinite(point.volume ?? NaN) && Number(point.volume) > 0)
        .map((point) => {
            const close = Number(point.close ?? point.price);
            const open = Number(point.open ?? close);
            return {
                time: toChartTime(point.timestamp),
                value: Number(point.volume),
                color: withAlpha(close >= open ? theme.bull : theme.bear, 0.35),
            };
        });
}

const PortfolioPriceChart: React.FC<PortfolioPriceChartProps> = ({ points, height = 260, isPositive }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const normalizedPoints = useMemo(() => normalizePoints(points), [points]);
    const candleData = useMemo(() => toCandles(normalizedPoints), [normalizedPoints]);
    const areaData = useMemo(() => toArea(normalizedPoints), [normalizedPoints]);
    const hasVolume = useMemo(
        () => normalizedPoints.some((point) => Number.isFinite(point.volume ?? NaN) && Number(point.volume) > 0),
        [normalizedPoints],
    );

    useEffect(() => {
        const container = containerRef.current;
        if (!container || normalizedPoints.length === 0) return;

        const theme = readChartTheme();
        const chart = createChart(container, {
            width: container.clientWidth,
            height,
            autoSize: false,
            ...chartOptions(theme),
            rightPriceScale: {
                borderColor: theme.axis,
                scaleMargins: { top: 0.08, bottom: hasVolume ? 0.24 : 0.08 },
            },
            timeScale: {
                borderColor: theme.axis,
                timeVisible: false,
                secondsVisible: false,
            },
            localization: {
                priceFormatter: (price: number) => `$${price.toFixed(price >= 100 ? 2 : 3)}`,
            },
        });

        let candleSeries: ISeriesApi<'Candlestick'> | null = null;
        let areaSeries: ISeriesApi<'Area'> | null = null;
        let volumeSeries: ISeriesApi<'Histogram'> | null = null;

        if (candleData.length >= Math.max(2, Math.floor(normalizedPoints.length * 0.6))) {
            candleSeries = chart.addSeries(CandlestickSeries, candleOptions(theme, isPositive));
            candleSeries.setData(candleData);
        } else {
            areaSeries = chart.addSeries(AreaSeries, { ...areaOptions(theme, isPositive), lineWidth: 2 });
            areaSeries.setData(areaData);
        }

        if (hasVolume) {
            volumeSeries = chart.addSeries(HistogramSeries, {
                priceFormat: { type: 'volume' },
                priceScaleId: 'volume',
            });
            volumeSeries.priceScale().applyOptions({
                scaleMargins: { top: 0.78, bottom: 0 },
                borderVisible: false,
            });
            volumeSeries.setData(toVolume(normalizedPoints, theme));
        }

        chart.timeScale().fitContent();
        chartRef.current = chart;

        // Re-read the tokens when the OS colour scheme or the [data-theme] attribute flips.
        const applyTheme = () => {
            const next = readChartTheme();
            chart.applyOptions(chartOptions(next));
            candleSeries?.applyOptions(candleOptions(next, isPositive));
            areaSeries?.applyOptions(areaOptions(next, isPositive));
            volumeSeries?.setData(toVolume(normalizedPoints, next));
        };
        const colorScheme = typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-color-scheme: dark)')
            : null;
        colorScheme?.addEventListener?.('change', applyTheme);
        const themeObserver = typeof MutationObserver === 'function' ? new MutationObserver(applyTheme) : null;
        themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        const resizeObserver = new ResizeObserver(([entry]) => {
            const width = Math.floor(entry.contentRect.width);
            if (width > 0) {
                chart.applyOptions({ width, height });
                chart.timeScale().fitContent();
            }
        });
        resizeObserver.observe(container);

        return () => {
            colorScheme?.removeEventListener?.('change', applyTheme);
            themeObserver?.disconnect();
            resizeObserver.disconnect();
            chart.remove();
            chartRef.current = null;
        };
    }, [areaData, candleData, hasVolume, height, isPositive, normalizedPoints]);

    if (normalizedPoints.length === 0) {
        return (
            <div
                data-testid="portfolio-price-chart-empty"
                style={{
                    height,
                    border: '1px solid var(--q-border)',
                    borderRadius: 'var(--q-radius)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--q-text-muted)',
                    fontSize: 13,
                }}
            >
                Market history unavailable
            </div>
        );
    }

    return (
        <div
            data-testid="portfolio-price-chart-canvas"
            ref={containerRef}
            style={{
                height,
                minWidth: 0,
                width: '100%',
            }}
        />
    );
};

export default PortfolioPriceChart;
