import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import gsap from 'gsap';
import { Sparkline } from './charts/Sparkline';

interface StatTileProps {
  label: string;
  value: number | null;
  icon: React.ComponentType<{ className?: string }>;
  accentClass: string;
  history: number[];
  color: string;
  delay?: number;
  suffix?: string;
}

export const StatTile: React.FC<StatTileProps> = ({ label, value, icon: Icon, accentClass, history, color, delay = 0, suffix = '' }) => {
  const numberRef = useRef<HTMLDivElement>(null);
  const prevValue = useRef(0);

  useEffect(() => {
    const el = numberRef.current;
    if (!el || value === null) return;
    const counter = { n: prevValue.current };
    gsap.to(counter, {
      n: value,
      duration: 0.6,
      ease: 'power2.out',
      onUpdate: () => {
        el.textContent = Math.round(counter.n).toString() + suffix;
      },
    });
    prevValue.current = value;
  }, [value, suffix]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay, ease: 'easeOut' }}
      className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-5 shadow-card hover:shadow-elevated hover:-translate-y-0.5 transition-[box-shadow,transform] duration-200"
    >
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${accentClass}`}>
          <Icon className="w-4.5 h-4.5" />
        </div>
        <div className="min-w-0">
          {value === null ? (
            <div className="text-2xl font-bold text-ink leading-tight">—</div>
          ) : (
            <div ref={numberRef} className="text-2xl font-bold text-ink leading-tight">
              0{suffix}
            </div>
          )}
          <div className="text-xs text-ink-muted leading-tight">{label}</div>
        </div>
      </div>
      {/* The trend line only means something once there's movement to show. */}
      {history.some((v) => v > 0) && (
        <div className="mt-3">
          <Sparkline data={history} color={color} height={36} />
        </div>
      )}
    </motion.div>
  );
};
