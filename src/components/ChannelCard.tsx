import React from 'react';
import { motion } from 'framer-motion';
import { ActivityScatter, ScatterPoint } from './charts/ActivityScatter';

interface ChannelStat {
  label: string;
  value: string | number;
}

interface ChannelCardProps {
  icon: React.ComponentType<{ className?: string }>;
  iconClassName: string;
  name: string;
  mode: string;
  identifier?: string;
  status: 'ok' | 'attention' | 'checking';
  stats: ChannelStat[];
  description: string;
  scatterPoints: ScatterPoint[];
  delay?: number;
}

const STATUS_STYLE: Record<ChannelCardProps['status'], string> = {
  ok: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
  attention: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
  checking: 'bg-border-strong text-ink-muted border border-border',
};

const STATUS_LABEL: Record<ChannelCardProps['status'], string> = {
  ok: 'Live',
  attention: 'Needs attention',
  checking: 'Checking…',
};

export const ChannelCard: React.FC<ChannelCardProps> = ({
  icon: Icon,
  iconClassName,
  name,
  mode,
  identifier,
  status,
  stats,
  description,
  scatterPoints,
  delay = 0,
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: 'easeOut' }}
      className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-5 shadow-card hover:shadow-elevated hover:-translate-y-0.5 transition-[box-shadow,transform] duration-200 flex flex-col"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${iconClassName}`}>
            <Icon className="w-4.5 h-4.5" />
          </div>
          <h3 className="font-semibold text-sm text-ink truncate">{name}</h3>
        </div>
      </div>

      <div className="flex items-center flex-wrap gap-1.5 mb-4 text-[10px]">
        <span className={`px-1.5 py-0.5 rounded-full font-semibold ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>
        <span className="text-ink-muted">{mode}</span>
        {identifier && (
          <>
            <span className="text-ink-muted">·</span>
            <span className="text-ink-muted truncate">{identifier}</span>
          </>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        {stats.map((s) => (
          <div key={s.label} className="min-w-0">
            <div className="text-lg font-bold text-ink truncate">{s.value}</div>
            <div className="text-[10px] text-ink-muted truncate">{s.label}</div>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-ink-muted leading-relaxed mb-4 line-clamp-2">{description}</p>

      <div className="mt-auto pt-3 border-t border-border">
        <ActivityScatter points={scatterPoints} />
      </div>
    </motion.div>
  );
};
