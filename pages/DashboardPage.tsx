import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bitcoin, Factory, Globe, Hash, LayoutDashboard, Loader2, Pause, Play, TrendingUp, Zap } from 'lucide-react';
import NewsCard from '../components/NewsCard';
import { useNewsStore } from '../stores/newsStore';
import { Category, DataMode, NewsItem, Sentiment } from '../types';
import { fetchNewsFromBackend, useAnalyzeNews, useDeepDiveNews, useNews, NEWS_FEED_LIMIT, NEWS_QUERY_KEY, NewsQueryResult } from '../hooks/queries/useNewsQueries';
import { useQueryClient } from '@tanstack/react-query';
import '../styles/dashboard.css';

// Feed filter (moved here from the old side menu in desk v2).
const CATEGORIES = [
    { id: Category.ALL, label: 'All Markets', icon: LayoutDashboard },
    { id: Category.CRYPTO, label: 'Crypto & DeFi', icon: Bitcoin },
    { id: Category.STOCKS, label: 'Equities', icon: TrendingUp },
    { id: Category.FOREX, label: 'Forex', icon: Globe },
    { id: Category.COMMODITIES, label: 'Commodities', icon: Factory },
    { id: Category.STARTUP, label: 'Startups & AI', icon: Zap },
    { id: Category.MACRO, label: 'Macro / Geo', icon: Globe },
];

const formatAsOf = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const DashboardPage: React.FC = () => {
    const { activeCategory, setActiveCategory, isStreamActive, toggleStream, setNewsItems } = useNewsStore();
    const newsQuery = useNews(isStreamActive);
    const analyzeMutation = useAnalyzeNews();
    const { mutate: deepDive } = useDeepDiveNews();
    const queryClient = useQueryClient();
    const scrollRef = useRef<HTMLDivElement>(null);
    const autoAnalyzeSeenRef = useRef(new Set<string>());
    const autoAnalyzeActiveRef = useRef(false);
    const [isManualFetchActive, setIsManualFetchActive] = useState(false);
    const allNews = newsQuery.data?.items ?? [];

    useEffect(() => {
        if (newsQuery.data) {
            setNewsItems(newsQuery.data.items, newsQuery.data.mode);
        }
    }, [newsQuery.data, setNewsItems]);

    const news = activeCategory === Category.ALL
        ? allNews
        : allNews.filter((item) => item.category === activeCategory);
    const criticalNews = news.filter((item) => item.score && item.score > 90);

    // Presentation only: scored stories first (highest Signal score first), the rest of the feed after them.
    const isScored = (item: NewsItem) => item.isAnalyzed && item.score !== undefined;
    const scoredNews = news.filter(isScored).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const pendingNews = news.filter((item) => !isScored(item));
    const scoreTotal = scoredNews.reduce((sum, item) => sum + (item.score ?? 0), 0);
    const averageScore = scoredNews.length > 0 ? scoreTotal / scoredNews.length : undefined;
    const upCount = scoredNews.filter((item) => item.sentiment === Sentiment.POSITIVE).length;
    const downCount = scoredNews.filter((item) => item.sentiment === Sentiment.NEGATIVE).length;
    const neutralCount = scoredNews.length - upCount - downCount;
    const latestTimestamp = news.length > 0 ? Math.max(...news.map((item) => item.timestamp)) : undefined;
    const aiModes = new Set<DataMode | undefined>(scoredNews.map((item) => item.analysisMode));
    const aiModeLabel = aiModes.size === 0
        ? 'no AI assessment yet'
        : aiModes.size > 1
            ? 'mixed AI modes'
            : aiModes.has('live')
                ? 'AI live'
                : aiModes.has('simulation')
                    ? 'AI simulation'
                    : aiModes.has('fallback')
                        ? 'AI fallback'
                        : 'AI mode not reported';
    const feedModeLabel = newsQuery.data?.mode === 'live' ? 'Feed live' : 'Feed fallback';

    // One flat keyed list so a story keeps its card state (expanded, export) when it moves from the feed into the scored group.
    const storyNodes: React.ReactNode[] = [];
    storyNodes.push(
        <div key="group-moving" className="qd-group-head">
            <h2 className="qd-group-title">{"What's moving your portfolio"}</h2>
            <p className="qd-group-sub">
                {scoredNews.length > 0
                    ? `${scoredNews.length} scored ${scoredNews.length === 1 ? 'story' : 'stories'}, highest Signal score first. Each shows its source, how reliable that source is, and whether the assessment is live or an AI simulation.`
                    : 'Scored stories appear here, highest Signal score first, as the agents finish assessing them.'}
            </p>
        </div>
    );
    scoredNews.forEach((item, index) => {
        storyNodes.push(
            <NewsCard
                key={item.id}
                variant={index === 0 ? 'lead' : 'column'}
                item={item}
                onAnalyze={() => analyzeMutation.mutate(item)}
                onGenerateDeepDive={() => deepDive(item)}
            />
        );
    });
    if (pendingNews.length > 0) {
        storyNodes.push(
            <div key="group-rest" className="qd-group-head qd-group-head--rest">
                <h2 className="qd-group-title">Remaining feed</h2>
                <p className="qd-group-sub">
                    {`${pendingNews.length} ${pendingNews.length === 1 ? 'story is' : 'stories are'} waiting for an assessment and will move up once scored.`}
                </p>
            </div>
        );
        pendingNews.forEach((item) => {
            storyNodes.push(
                <NewsCard
                    key={item.id}
                    variant="column"
                    item={item}
                    onAnalyze={() => analyzeMutation.mutate(item)}
                    onGenerateDeepDive={() => deepDive(item)}
                />
            );
        });
    }

    const handleRefetch = async () => {
        if (isManualFetchActive) return;
        setIsManualFetchActive(true);
        try {
            const refreshed = await fetchNewsFromBackend({ force: true });
            queryClient.setQueryData<NewsQueryResult>(NEWS_QUERY_KEY, refreshed);
            setNewsItems(refreshed.items, refreshed.mode);
        } finally {
            setIsManualFetchActive(false);
        }
    };

    useEffect(() => {
        if (!isStreamActive || !newsQuery.data || autoAnalyzeActiveRef.current) return;

        const nextItem = newsQuery.data.items.slice(0, NEWS_FEED_LIMIT).find((item) =>
            !item.isAnalyzed
            && !item.isAnalysing
            && !item.analysisQueued
            && !autoAnalyzeSeenRef.current.has(item.id)
        );

        if (!nextItem) return;

        autoAnalyzeSeenRef.current.add(nextItem.id);
        autoAnalyzeActiveRef.current = true;
        queryClient.setQueryData<NewsQueryResult>(NEWS_QUERY_KEY, (old) =>
            old
                ? { ...old, items: old.items.map((item) => item.id === nextItem.id ? { ...item, analysisQueued: true } : item) }
                : old
        );

        analyzeMutation.mutate(nextItem, {
            onSettled: () => {
                autoAnalyzeActiveRef.current = false;
            },
        });
    }, [analyzeMutation, isStreamActive, newsQuery.data, queryClient]);

    return (
        <div className="qd-page">
            <header className="q-page-header">
                <div>
                    <h2 className="q-page-title">Live Intelligence Feed</h2>
                    <p className="q-page-sub">Real-time NLP analysis · Signal score · Multi-source</p>
                </div>
                <div className="q-header-actions">
                    <button
                        onClick={() => { void handleRefetch(); }}
                        disabled={isManualFetchActive}
                        aria-busy={isManualFetchActive}
                        className="q-btn q-btn--ghost q-btn--sm"
                    >
                        <Hash size={13} />
                        {isManualFetchActive ? 'Fetching...' : 'Fetch Latest'}
                    </button>
                    <button onClick={toggleStream} className={`q-btn q-btn--sm ${isStreamActive ? 'q-btn--live' : 'q-btn--paused'}`}>
                        {isStreamActive ? <Pause size={13} /> : <Play size={13} />}
                        {isStreamActive ? 'Live' : 'Paused'}
                    </button>
                </div>
            </header>

            {criticalNews.length > 0 && (
                <div className="q-critical-ticker">
                    <AlertTriangle size={14} style={{ color: 'var(--q-bear)', flexShrink: 0 }} />
                    <span className="q-ticker-label">CRITICAL ALERT:</span>
                    <div className="q-ticker-items">
                        {[...criticalNews, ...criticalNews].map((item, index) => (
                            <span key={`${item.id}-${index}`} className="q-ticker-item">
                                {item.headline} <span className="q-ticker-score">({item.score})</span>
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <div className="q-scroll-area" ref={scrollRef}>
                <div className="q-content-max qd-feed">
                    {newsQuery.isLoading ? (
                        <div className="q-empty">
                            <div className="q-empty-icon">
                                <Loader2 size={32} className="qd-spin qd-loading-icon" />
                            </div>
                            <p className="q-empty-title">Initializing Neural Networks...</p>
                            <p className="q-empty-sub">Connecting to market intelligence feeds</p>
                        </div>
                    ) : news.length === 0 ? (
                        <div className="q-empty">
                            <p className="q-empty-title">No Intelligence Found</p>
                            <p className="q-empty-sub">Wait for new data to arrive</p>
                        </div>
                    ) : (
                        <>
                            <section className="qd-summary" aria-label="Feed summary">
                                <dl className="qd-summary__grid">
                                    <div className="qd-summary__cell">
                                        <dt>Stories in view</dt>
                                        <dd className="qd-summary__value">{news.length}</dd>
                                        <dd className="qd-summary__note">{activeCategory === Category.ALL ? 'all categories' : `category ${activeCategory}`}</dd>
                                    </div>
                                    <div className="qd-summary__cell">
                                        <dt>Scored</dt>
                                        <dd className="qd-summary__value">{scoredNews.length} <span className="qd-summary__of">of {news.length}</span></dd>
                                        <dd className="qd-summary__note">{pendingNews.length} awaiting assessment</dd>
                                    </div>
                                    <div className="qd-summary__cell">
                                        <dt>Average Signal score</dt>
                                        <dd className="qd-summary__value">{averageScore !== undefined ? averageScore.toFixed(1) : '\u2014'}</dd>
                                        <dd className="qd-summary__note">scored stories, 0 to 100</dd>
                                    </div>
                                    <div className="qd-summary__cell">
                                        <dt>Direction of scored stories</dt>
                                        <dd className="qd-summary__value">
                                            <span className="qd-summary__up">{`\u25B2 ${upCount}`}</span>
                                            {' '}
                                            <span className="qd-summary__down">{`\u25BC ${downCount}`}</span>
                                        </dd>
                                        <dd className="qd-summary__note">{neutralCount} neutral</dd>
                                    </div>
                                    <div className="qd-summary__cell">
                                        <dt>As of</dt>
                                        <dd className="qd-summary__value">{latestTimestamp !== undefined ? formatAsOf(latestTimestamp) : '\u2014'}</dd>
                                        <dd className="qd-summary__note">{feedModeLabel} · {aiModeLabel}</dd>
                                    </div>
                                </dl>
                            </section>
                            <div className="qd-layout">
                                <div className="qd-stories qd-layout__main">
                                    {storyNodes}
                                </div>
                                <aside className="qd-layout__aside" aria-label="Feed filter">
                                    <div className="qd-filter">
                                        <h2 className="qd-filter__title">Feed filter</h2>
                                        {CATEGORIES.map(({ id, label, icon: Icon }) => (
                                            <button
                                                key={id}
                                                type="button"
                                                aria-pressed={activeCategory === id}
                                                onClick={() => setActiveCategory(id)}
                                                className={`qd-filter__item${activeCategory === id ? ' qd-filter__item--active' : ''}`}
                                            >
                                                <Icon size={15} />
                                                <span>{label}</span>
                                            </button>
                                        ))}
                                    </div>
                                    <p className="qd-legend">
                                        Signal score (0 to 100) describes the strength of a news signal, not an expected return. Reliability (0 to 100) rates the news source. Quorum supports decisions; it is not investment advice.
                                    </p>
                                </aside>
                            </div>
                        </>
                    )}
                    <div className="qd-spacer" />
                </div>
            </div>
        </div>
    );
};

export default DashboardPage;
