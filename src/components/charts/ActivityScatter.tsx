import React, { useEffect, useMemo, useRef } from 'react';
import gsap from 'gsap';

export type ScatterOutcome = 'good' | 'warn' | 'bad';

export interface ScatterPoint {
  id: string;
  outcome: ScatterOutcome;
}

interface ActivityScatterProps {
  points: ScatterPoint[];
  height?: number;
  leftLabel?: string;
  rightLabel?: string;
  topLabel?: string;
  bottomLabel?: string;
}

const OUTCOME_COLOR: Record<ScatterOutcome, string> = {
  good: '#25D366',
  warn: '#F59E0B',
  bad: '#F43F5E',
};

// Deterministic pseudo-random jitter (seeded by index) so dots scatter organically like
// the reference chart's CSAT strip, without the dots reflowing to new positions on every
// re-render — real per-point outcome data drives color/lane, jitter is purely cosmetic.
function jitter(seed: number): number {
  const x = Math.sin(seed * 999) * 10000;
  return x - Math.floor(x);
}

const WIDTH = 400;

export const ActivityScatter: React.FC<ActivityScatterProps> = ({
  points,
  height = 90,
  leftLabel = '30 sec ago',
  rightLabel = 'Now',
  topLabel = 'Satisfied',
  bottomLabel = 'Unsatisfied',
}) => {
  const groupRef = useRef<SVGGElement>(null);
  const dots = useMemo(() => {
    const n = points.length;
    return points.map((p, i) => {
      const lane = p.outcome === 'good' ? 0.22 : p.outcome === 'warn' ? 0.5 : 0.8;
      const x = n <= 1 ? WIDTH / 2 : (i / (n - 1)) * (WIDTH - 20) + 10;
      const y = lane * height + (jitter(i) - 0.5) * height * 0.28;
      return { ...p, x, y: Math.min(height - 6, Math.max(6, y)) };
    });
  }, [points, height]);

  useEffect(() => {
    const nodes = groupRef.current?.querySelectorAll('circle');
    if (!nodes || nodes.length === 0) return;
    gsap.fromTo(
      nodes,
      { scale: 0, opacity: 0, transformOrigin: 'center' },
      { scale: 1, opacity: 1, duration: 0.35, ease: 'back.out(2)', stagger: { each: 0.01, from: 'random' } }
    );
  }, [dots.length]);

  return (
    <div>
      <div className="flex items-center justify-between text-[9px] text-ink-muted mb-0.5">
        <span>{topLabel}</span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
        <line x1={0} y1={height / 2} x2={WIDTH} y2={height / 2} stroke="currentColor" strokeOpacity={0.08} strokeDasharray="3 3" />
        <g ref={groupRef}>
          {dots.map((d) => (
            <circle key={d.id} cx={d.x} cy={d.y} r={3.2} fill={OUTCOME_COLOR[d.outcome]} />
          ))}
        </g>
      </svg>
      <div className="flex items-center justify-between text-[9px] text-ink-muted mt-0.5">
        <span>{bottomLabel}</span>
      </div>
      <div className="flex items-center justify-between text-[9px] text-ink-muted mt-1">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  );
};
