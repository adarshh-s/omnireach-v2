import React, { useEffect, useState } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { PageHeader, headerSecondaryButton } from './PageHeader';
import type { AnalyticsReport } from '../../lib/analytics';

interface ReportsViewProps {
  accessToken?: string | null;
}

const card = 'bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl shadow-card';

function Rate({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2 min-w-[88px]">
      <div className="flex-1 h-1.5 bg-border-strong rounded-full overflow-hidden">
        <div className="h-1.5 bg-[#128C7E] rounded-full" style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="text-ink tabular-nums w-11 text-right">{value}%</span>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={`${card} p-4`}>
      <div className="text-2xl font-bold text-ink tabular-nums">{value}</div>
      <div className="text-xs text-ink-muted mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-ink-muted mt-1">{sub}</div>}
    </div>
  );
}

const th = 'px-4 py-2.5 font-semibold text-left whitespace-nowrap';
const td = 'px-4 py-2.5 whitespace-nowrap';

/** Per-campaign and per-template results (lib/analytics.ts): reply and booking rates, so it's
 * clear which campaigns and which message templates actually get meetings. */
export const ReportsView: React.FC<ReportsViewProps> = ({ accessToken }) => {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/conversations?action=analytics', { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not load reports.');
      setReport(data);
    } catch (err: any) {
      setError(err?.message || 'Could not load reports.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const t = report?.totals;
  const date = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const channelLabel = (channels: string[]) => channels.map((c) => (c === 'whatsapp' ? 'WhatsApp' : c === 'email' ? 'Email' : c)).join(' + ') || '—';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Which campaigns and templates get replies and meetings — out of the leads each one actually reached."
        actions={
          <button onClick={load} disabled={loading || !accessToken} className={headerSecondaryButton}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        }
      />

      {!accessToken && <div className={`${card} p-6 text-sm text-ink-muted`}>Sign in to a workspace to see reports.</div>}
      {error && <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-300">{error}</div>}
      {accessToken && !report && !error && (
        <div className={`${card} p-8 text-center text-xs text-ink-muted`}>
          <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
          Loading reports…
        </div>
      )}

      {report && t && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Messages sent" value={String(t.sent)} sub="WhatsApp and email, first messages" />
            <Tile label="Reply rate" value={`${t.sent ? Math.round((t.replied / t.sent) * 1000) / 10 : 0}%`} sub={`${t.replied} leads replied`} />
            <Tile label="Meetings booked" value={String(t.booked + t.callBookings)} sub={`${t.booked} by message · ${t.callBookings} on calls`} />
            <Tile label="Calls answered" value={`${t.calls ? Math.round((t.answered / t.calls) * 1000) / 10 : 0}%`} sub={`${t.answered} of ${t.calls} calls`} />
          </div>

          <section className={card}>
            <div className="px-4 pt-4 pb-2">
              <h2 className="text-sm font-semibold text-ink">Campaigns</h2>
              <p className="text-[11px] text-ink-muted">WhatsApp and email campaigns, newest first.</p>
            </div>
            {report.messageCampaigns.length === 0 ? (
              <p className="px-4 pb-5 text-xs text-ink-muted">No campaigns yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-ink-muted border-y border-border">
                    <tr>
                      <th className={th}>Campaign</th>
                      <th className={th}>Template</th>
                      <th className={th}>Sent</th>
                      <th className={th}>Replied</th>
                      <th className={th}>Reply rate</th>
                      <th className={th}>Booked</th>
                      <th className={th}>Booking rate</th>
                      <th className={th}>Failed</th>
                      <th className={th}>Opted out</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-ink-secondary">
                    {report.messageCampaigns.map((c) => (
                      <tr key={c.id} className="hover:bg-surface-hover">
                        <td className={td}>
                          <div className="text-ink font-medium">{date(c.createdAt)}</div>
                          <div className="text-[10px] text-ink-muted">
                            {channelLabel(c.channels)}
                            {c.followupsSent ? ` · ${c.followupsSent} follow-ups` : ''}
                          </div>
                        </td>
                        <td className={`${td} max-w-[220px] truncate`} title={c.templateName || undefined}>
                          {c.templateName || <span className="text-ink-muted">—</span>}
                        </td>
                        <td className={`${td} tabular-nums`}>
                          {c.sent}
                          <span className="text-ink-muted"> / {c.leads}</span>
                        </td>
                        <td className={`${td} tabular-nums`}>{c.replied}</td>
                        <td className={td}>
                          <Rate value={c.replyRate} />
                        </td>
                        <td className={`${td} tabular-nums`}>{c.booked}</td>
                        <td className={td}>
                          <Rate value={c.bookingRate} />
                        </td>
                        <td className={`${td} tabular-nums ${c.failed ? 'text-rose-400' : ''}`}>{c.failed}</td>
                        <td className={`${td} tabular-nums`}>{c.optedOut}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={card}>
            <div className="px-4 pt-4 pb-2">
              <h2 className="text-sm font-semibold text-ink">Templates</h2>
              <p className="text-[11px] text-ink-muted">Every campaign that used a template, added up — the best performers at the top of your mind.</p>
            </div>
            {report.templates.length === 0 ? (
              <p className="px-4 pb-5 text-xs text-ink-muted">No template results yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-ink-muted border-y border-border">
                    <tr>
                      <th className={th}>Template</th>
                      <th className={th}>Campaigns</th>
                      <th className={th}>Sent</th>
                      <th className={th}>Reply rate</th>
                      <th className={th}>Booking rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-ink-secondary">
                    {report.templates.map((tpl) => (
                      <tr key={tpl.templateName} className="hover:bg-surface-hover">
                        <td className={`${td} text-ink font-medium`}>{tpl.templateName}</td>
                        <td className={`${td} tabular-nums`}>{tpl.campaigns}</td>
                        <td className={`${td} tabular-nums`}>{tpl.sent}</td>
                        <td className={td}>
                          <Rate value={tpl.replyRate} />
                        </td>
                        <td className={td}>
                          <Rate value={tpl.bookingRate} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={card}>
            <div className="px-4 pt-4 pb-2">
              <h2 className="text-sm font-semibold text-ink">AI call campaigns</h2>
              <p className="text-[11px] text-ink-muted">Answer and booking rates are out of calls actually placed.</p>
            </div>
            {report.callCampaigns.length === 0 ? (
              <p className="px-4 pb-5 text-xs text-ink-muted">No call campaigns yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-ink-muted border-y border-border">
                    <tr>
                      <th className={th}>Started</th>
                      <th className={th}>Called</th>
                      <th className={th}>Answered</th>
                      <th className={th}>Answer rate</th>
                      <th className={th}>Booked</th>
                      <th className={th}>Booking rate</th>
                      <th className={th}>Avg. call</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-ink-secondary">
                    {report.callCampaigns.map((c) => (
                      <tr key={c.id} className="hover:bg-surface-hover">
                        <td className={td}>
                          <div className="text-ink font-medium">{date(c.createdAt)}</div>
                          <div className="text-[10px] text-ink-muted capitalize">{c.status}</div>
                        </td>
                        <td className={`${td} tabular-nums`}>
                          {c.called}
                          <span className="text-ink-muted"> / {c.leads}</span>
                        </td>
                        <td className={`${td} tabular-nums`}>{c.answered}</td>
                        <td className={td}>
                          <Rate value={c.answerRate} />
                        </td>
                        <td className={`${td} tabular-nums`}>{c.booked}</td>
                        <td className={td}>
                          <Rate value={c.bookingRate} />
                        </td>
                        <td className={`${td} tabular-nums`}>
                          {c.avgDurationSeconds ? `${Math.floor(c.avgDurationSeconds / 60)}m ${c.avgDurationSeconds % 60}s` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};
