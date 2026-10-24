import React, { useEffect, useState } from 'react';
import type { OrgUsage, UsageMetric } from '../../lib/usage';

// Kept here rather than imported from lib/usage.ts, which is server code.
const METRICS: { key: UsageMetric; label: string; phrase: string }[] = [
  { key: 'calls', label: 'Outbound AI calls', phrase: 'outbound AI calls' },
  { key: 'call_minutes', label: 'Call minutes', phrase: 'call minutes' },
  { key: 'whatsapp', label: 'WhatsApp messages', phrase: 'WhatsApp messages' },
  { key: 'emails', label: 'Emails', phrase: 'emails' },
  { key: 'ai', label: 'AI generations', phrase: 'AI generations' },
];
const listOf = (items: { phrase: string }[]) => items.map((m) => m.phrase).join(', ').replace(/, ([^,]*)$/, ' and $1');

const card = 'bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl shadow-card';

/** This month's usage and limits for the signed-in workspace (lib/usage.ts). */
export function useOrgUsage(accessToken: string | null | undefined): OrgUsage | null {
  const [usage, setUsage] = useState<OrgUsage | null>(null);
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    const load = () =>
      fetch('/api/whatsapp/subscribe-app?action=usage', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data?.used) setUsage(data);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [accessToken]);
  return usage;
}

const pctOf = (used: number, limit: number | null) => (limit ? Math.min(100, Math.round((used / limit) * 100)) : 0);
const monthLabel = (period: string) => new Date(`${period}-01T00:00:00Z`).toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const UsagePanel: React.FC<{ usage: OrgUsage | null }> = ({ usage }) => {
  if (!usage) return null;
  return (
    <section className={`${card} p-4`}>
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-ink">Usage — {monthLabel(usage.period)}</h2>
        <span className="text-[10px] text-ink-muted">Resets on the 1st</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {METRICS.map(({ key, label }) => {
          const used = Math.round(usage.used[key] || 0);
          const limit = usage.limits[key];
          const pct = pctOf(used, limit);
          const bar = pct >= 100 ? 'bg-rose-400' : pct >= 80 ? 'bg-amber-400' : 'bg-[#128C7E]';
          return (
            <div key={key}>
              <div className="text-lg font-bold text-ink tabular-nums">
                {used.toLocaleString()}
                {limit !== null && <span className="text-xs font-normal text-ink-muted"> / {limit.toLocaleString()}</span>}
              </div>
              <div className="text-[11px] text-ink-muted">{label}</div>
              {limit !== null ? (
                <div className="mt-1.5 h-1.5 bg-border-strong rounded-full overflow-hidden">
                  <div className={`h-1.5 rounded-full ${bar}`} style={{ width: `${pct}%` }} />
                </div>
              ) : (
                <div className="mt-1 text-[10px] text-ink-muted">No limit</div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

/** Shown across the app once any monthly limit is 80% used, and in red once one is reached. */
export function usageWarning(usage: OrgUsage | null): { level: 'warn' | 'full'; message: string } | null {
  if (!usage) return null;
  const full = METRICS.filter(({ key }) => usage.limits[key] !== null && usage.used[key] >= usage.limits[key]!);
  if (full.length) {
    return {
      level: 'full',
      message: `Monthly limit reached for ${listOf(full)}. New campaign sends and calls on it are on hold until the 1st — replies to leads already talking to the AI still go out. Contact support to raise the limit.`,
    };
  }
  const near = METRICS.filter(({ key }) => pctOf(usage.used[key], usage.limits[key]) >= 80);
  if (near.length) {
    return { level: 'warn', message: `Over 80% of this month's limit used for ${listOf(near)}.` };
  }
  return null;
}
