import React, { useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, Lock, Unlock, Loader2 } from 'lucide-react';

interface OrgSummary {
  orgId: string;
  email: string | null;
  companyName: string | null;
  createdAt: string;
  status: 'active' | 'locked';
}

interface AdminDashboardProps {
  accessToken?: string | null;
}

/** Admin-only — visible in the sidebar only when the signed-in email matches VITE_ADMIN_EMAIL
 * (cosmetic gating; the actual enforcement is server-side in api/whatsapp/subscribe-app.ts's
 * ?action=admin-* routes, which check ADMIN_EMAIL against the caller's verified token). Lists
 * every org and lets the owner flip a workspace active/locked after a deal is agreed outside
 * the app — there's no self-serve subscription checkout by design. */
export const AdminDashboard: React.FC<AdminDashboardProps> = ({ accessToken }) => {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingOrgId, setPendingOrgId] = useState<string | null>(null);

  const loadOrgs = () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    fetch('/api/whatsapp/subscribe-app?action=admin-list-orgs', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.orgs) setOrgs(data.orgs);
        else setError(data?.error || 'Could not load organizations.');
      })
      .catch(() => setError('Failed to reach the server.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadOrgs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const toggleStatus = async (org: OrgSummary) => {
    if (!accessToken) return;
    const nextStatus = org.status === 'active' ? 'locked' : 'active';
    setPendingOrgId(org.orgId);
    try {
      const res = await fetch('/api/whatsapp/subscribe-app?action=admin-set-org-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ orgId: org.orgId, status: nextStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setOrgs((prev) => prev?.map((o) => (o.orgId === org.orgId ? { ...o, status: nextStatus } : o)) || prev);
      } else {
        setError(data?.error || 'Could not update this organization.');
      }
    } catch {
      setError('Failed to reach the server.');
    } finally {
      setPendingOrgId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#4285F4]/15 flex items-center justify-center text-[#4285F4] shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-ink">Admin — Organizations</h1>
            <p className="text-xs text-ink-muted mt-0.5">
              Every signed-up workspace. Flip access on after a deal is agreed and paid outside the app.
            </p>
          </div>
        </div>
        <button
          onClick={loadOrgs}
          disabled={loading}
          className="p-2 rounded-full text-ink-muted hover:text-ink bg-surface-hover border border-border transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-300">{error}</div>
      )}

      <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl shadow-card overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-ink-muted uppercase tracking-wider text-[10px]">
              <th className="px-5 py-3 font-semibold">Email</th>
              <th className="px-5 py-3 font-semibold">Company</th>
              <th className="px-5 py-3 font-semibold">Signed Up</th>
              <th className="px-5 py-3 font-semibold">Status</th>
              <th className="px-5 py-3 font-semibold text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {orgs === null && !error && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-ink-muted">
                  <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                  Loading organizations…
                </td>
              </tr>
            )}
            {orgs?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-ink-muted">No organizations yet.</td>
              </tr>
            )}
            {orgs?.map((org) => (
              <tr key={org.orgId} className="hover:bg-surface-hover transition-colors">
                <td className="px-5 py-3 text-ink font-medium">{org.email || '—'}</td>
                <td className="px-5 py-3 text-ink-secondary">{org.companyName || '—'}</td>
                <td className="px-5 py-3 text-ink-muted">{new Date(org.createdAt).toLocaleDateString()}</td>
                <td className="px-5 py-3">
                  {org.status === 'active' ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                      Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                      Locked
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-right">
                  <button
                    onClick={() => toggleStatus(org)}
                    disabled={pendingOrgId === org.orgId}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-50 ${
                      org.status === 'active'
                        ? 'bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 border border-rose-500/20'
                        : 'bg-brand-strong text-white hover:bg-[#0d6e62]'
                    }`}
                  >
                    {pendingOrgId === org.orgId ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : org.status === 'active' ? (
                      <Lock className="w-3 h-3" />
                    ) : (
                      <Unlock className="w-3 h-3" />
                    )}
                    <span>{org.status === 'active' ? 'Lock' : 'Unlock'}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
