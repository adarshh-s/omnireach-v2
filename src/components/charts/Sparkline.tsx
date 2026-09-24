import React, { useEffect, useMemo, useRef } from 'react';
import gsap from 'gsap';

interface SparklineProps {
  data: number[];
  color?: string;
  height?: number;
  className?: string;
}

const WIDTH = 240;

function buildPath(data: number[], height: number): string {
  if (data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = WIDTH / (data.length - 1);
  const points = data.map((v, i) => {
    const x = i * step;
    const y = height - 4 - ((v - min) / span) * (height - 8);
    return [x, y] as const;
  });
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/** Animated trend line — draws itself in via stroke-dashoffset (no paid DrawSVG plugin
 * needed) and redraws smoothly whenever `data` grows, so it reads as genuinely live. */
export const Sparkline: React.FC<SparklineProps> = ({ data, color = '#25D366', height = 48, className }) => {
  const pathRef = useRef<SVGPathElement>(null);
  const gradientId = useMemo(() => `spark-grad-${Math.random().toString(36).slice(2)}`, []);
  const path = useMemo(() => buildPath(data, height), [data, height]);
  const fillPath = useMemo(() => (path ? `${path} L${WIDTH},${height} L0,${height} Z` : ''), [path, height]);

  useEffect(() => {
    const el = pathRef.current;
    if (!el || !path) return;
    const length = el.getTotalLength();
    gsap.fromTo(
      el,
      { strokeDasharray: length, strokeDashoffset: length },
      { strokeDashoffset: 0, duration: 0.9, ease: 'power2.out' }
    );
  }, [path]);

  if (data.length < 2) {
    return <div className={className} style={{ height }} />;
  }

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className={className} preserveAspectRatio="none" style={{ width: '100%', height }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradientId})`} stroke="none" />
      <path ref={pathRef} d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};
