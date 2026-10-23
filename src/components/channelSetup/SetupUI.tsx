import React from 'react';
import { CheckCircle2, AlertCircle, Info, RefreshCw, Copy, Check } from 'lucide-react';

/** Small building blocks for Channel Setup, so every section reads the same way: a header
 * with one live status line, then cards of essentials, with help tucked away. */

export const inputClass =
  'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-xs text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-brand-strong/30';

export interface SectionStatus {
  ok: boolean;
  message: string;
}

export const SetupSection: React.FC<{
  title: string;
  description: string;
  status?: SectionStatus | null;
  statusLoading?: boolean;
  onRefreshStatus?: () => void;
  children: React.ReactNode;
}> = ({ title, description, status, statusLoading, onRefreshStatus, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="text-xs text-ink-muted mt-0.5">{description}</p>
    </div>
    {(status || statusLoading) && (
      <div
        className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs border ${
          !status
            ? 'bg-surface border-border text-ink-muted'
            : status.ok
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
              : 'bg-amber-500/10 border-amber-500/20 text-amber-300'
        }`}
      >
        {!status ? (
          <RefreshCw className="w-3.5 h-3.5 mt-0.5 shrink-0 animate-spin" />
        ) : status.ok ? (
          <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        ) : (
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        )}
        <span className="flex-1">{status ? status.message : 'Checking connection…'}</span>
        {onRefreshStatus && status && (
          <button
            type="button"
            onClick={onRefreshStatus}
            disabled={statusLoading}
            className="opacity-70 hover:opacity-100 disabled:opacity-40"
            title="Check again"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>
    )}
    {children}
  </div>
);

export const Card: React.FC<{ title?: string; step?: number; aside?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  step,
  aside,
  children,
}) => (
  <div className="p-4 bg-canvas rounded-xl border border-border space-y-3">
    {(title || aside) && (
      <div className="flex items-center justify-between gap-2">
        {title && (
          <span className="text-xs font-semibold text-ink flex items-center gap-2">
            {step !== undefined && (
              <span className="w-5 h-5 rounded-full bg-brand-strong/20 text-brand-strong text-[10px] font-bold flex items-center justify-center">
                {step}
              </span>
            )}
            {title}
          </span>
        )}
        {aside}
      </div>
    )}
    {children}
  </div>
);

export const Field: React.FC<{ label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <label className="block text-[11px] font-medium text-ink-secondary mb-1">{label}</label>
    {children}
    {hint && <p className="text-[10px] text-ink-muted mt-1 leading-relaxed">{hint}</p>}
  </div>
);

export const ChoiceCard: React.FC<{
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
  badge?: string;
}> = ({ selected, onClick, title, description, badge }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={selected}
    className={`p-3 rounded-xl border text-left transition-all ${
      selected ? 'bg-brand-strong/10 border-brand-strong ring-1 ring-brand-strong/40' : 'bg-canvas border-border hover:border-border-strong'
    }`}
  >
    <div className="flex items-center gap-1.5">
      <span className={`w-3 h-3 rounded-full border-2 shrink-0 ${selected ? 'border-brand-strong bg-brand-strong' : 'border-border-strong'}`} />
      <span className={`text-xs font-semibold ${selected ? 'text-ink' : 'text-ink-secondary'}`}>{title}</span>
      {badge && <span className="ml-auto text-[9px] font-bold text-emerald-300 bg-emerald-500/15 px-1.5 py-0.5 rounded-full">{badge}</span>}
    </div>
    <p className="text-[11px] text-ink-muted mt-1 pl-[18px] leading-snug">{description}</p>
  </button>
);

export const Segmented = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) => (
  <div className="inline-flex flex-wrap gap-1 p-1 bg-surface rounded-lg border border-border">
    {options.map((o) => (
      <button
        key={o.value}
        type="button"
        onClick={() => onChange(o.value)}
        className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
          value === o.value ? 'bg-brand-strong text-white' : 'text-ink-muted hover:text-ink'
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

export const Note: React.FC<{ tone?: 'info' | 'warn' | 'error' | 'success'; children: React.ReactNode }> = ({ tone = 'info', children }) => {
  const styles = {
    info: 'bg-surface border-border text-ink-muted',
    warn: 'bg-amber-500/10 border-amber-500/20 text-amber-300',
    error: 'bg-rose-500/10 border-rose-500/20 text-rose-300',
    success: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
  }[tone];
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertCircle;
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed ${styles}`}>
      <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
};

export const CopyRow: React.FC<{ label: string; value: string; copied: boolean; onCopy: () => void; disabled?: boolean }> = ({
  label,
  value,
  copied,
  onCopy,
  disabled,
}) => (
  <Field label={label}>
    <div className="flex items-center gap-1.5">
      <code className="flex-1 min-w-0 bg-surface px-2.5 py-2 rounded-lg border border-border text-[11px] text-ink-secondary truncate">{value}</code>
      <button
        type="button"
        onClick={onCopy}
        disabled={disabled}
        className="p-2 rounded-lg border border-border bg-surface text-ink-secondary hover:text-ink shrink-0 disabled:opacity-40"
        title="Copy"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  </Field>
);

export const primaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg text-white bg-brand-strong hover:bg-[#0d6e62] disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
export const secondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg text-ink-secondary bg-surface border border-border-strong hover:text-ink disabled:opacity-50 transition-colors';
