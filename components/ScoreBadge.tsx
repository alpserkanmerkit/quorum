import React from 'react';
import '../styles/dashboard.css';

interface ScoreBadgeProps {
  score: number;
  /** 'md' sits in a story row, 'lg' beside the top story headline. */
  size?: 'md' | 'lg';
}

/**
 * Signal score = strength of a news signal on a 0-100 scale (not a forecast, not good/bad).
 * Always neutral ink; the tier is carried by border and weight, never by an up/down colour.
 */
const getTier = (score: number): 'high' | 'mid' | 'low' | 'none' => {
  if (score >= 80) return 'high';
  if (score >= 50) return 'mid';
  if (score > 0) return 'low';
  return 'none';
};

const ScoreBadge: React.FC<ScoreBadgeProps> = ({ score, size = 'md' }) => (
  <span
    title={`Signal score ${score}`}
    className={`qd-badge qd-badge--${size} qd-badge--${getTier(score)}`}
  >
    <span className="qd-badge__value">{score}</span>
    <span className="qd-badge__max">/100</span>
  </span>
);

export default ScoreBadge;
