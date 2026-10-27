import React, { useState } from 'react';
import { Download, Loader2, ShieldAlert, X } from 'lucide-react';
import type { Lead } from '../types';

interface LeadPrivacyDialogProps {
  lead: Lead;
  accessToken?: string | null;
  /** Only the workspace owner and admins may erase. */
  canErase: boolean;
  onClose: () => void;
  /** Called after the lead's data is erased on the server, to drop it from the list. */
  onErased: (leadId: string) => void;
}

/** A person's data-protection request (GDPR / DPDP / CCPA): download everything held on
 * them, or erase it (lib/leadData.ts). */
export const LeadPrivacyDialog: React.FC<LeadPrivacyDialogProps> = ({ lead, accessToken, canErase, onClose, onErased }) => {
  const [busy, setBusy] = useState<'export' | 'erase' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [keepBlocked, setKeepBlocked] = useState(true);
  const [elsewhere, setElsewhere] = useState<string[] | null>(null);

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };

  const exportData = async () => {
    setBusy('export');
    setError(null);
    try {
      const res = await fetch(`/api/whatsapp/subscribe-app?action=lead-export&id=${encodeURIComponent(lead.id)}`, { headers });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error || 'Could not export this lead.');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lead-data-${(lead.name || lead.id).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setElsewhere(data.heldElsewhere || null);
    } catch (err: any) {
      setError(err?.message || 'Could not export this lead.');
    } finally {
      setBusy(null);
    }
  };

  const erase = async () => {
    setBusy('erase');
    setError(null);
    try {
      const res = await fetch('/api/whatsapp/subscribe-app?action=lead-erase', {
        method: 'POST',
        headers,
        body: JSON.stringify({ clientId: lead.id, keepOnDoNotContact: keepBlocked }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error || 'Could not erase this lead.');
      onErased(lead.id);
      setElsewhere(data.heldElsewhere || []);
      setConfirming(false);
    } catch (err: any) {
      setError(err?.message || 'Could not erase this lead.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4" onClick={onClose}>
      <div className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-ink">Privacy request — {lead.name || 'this lead'}</h3>
            <p className="text-[11px] text-ink-muted mt-0.5">When someone asks what you hold on them, or asks you to delete it (GDPR, India's DPDP Act, CCPA).</p>
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {elsewhere ? (
          <div className="space-y-2">
            <p className="text-xs text-ink">Done. OmniReach can't reach these copies — handle them yourself if they apply:</p>
            <ul className="list-disc pl-4 space-y-1 text-[11px] text-ink-muted">
              {elsewhere.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <button onClick={onClose} className="w-full py-2 rounded-xl bg-brand-strong text-white text-xs font-semibold hover:bg-[#0d6e62]">
              Close
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={exportData}
              disabled={!!busy}
              className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:bg-surface-hover text-left disabled:opacity-50"
            >
              {busy === 'export' ? <Loader2 className="w-4 h-4 animate-spin text-ink-muted" /> : <Download className="w-4 h-4 text-[#128C7E]" />}
              <span>
                <span className="block text-xs font-semibold text-ink">Download their data</span>
                <span className="block text-[11px] text-ink-muted">Lead details, every WhatsApp, email and call transcript, and campaign history, as one file.</span>
              </span>
            </button>

            {canErase ? (
              !confirming ? (
                <button
                  onClick={() => setConfirming(true)}
                  disabled={!!busy}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-rose-500/30 hover:bg-rose-500/10 text-left disabled:opacity-50"
                >
                  <ShieldAlert className="w-4 h-4 text-rose-400" />
                  <span>
                    <span className="block text-xs font-semibold text-rose-300">Erase all their data</span>
                    <span className="block text-[11px] text-ink-muted">Deletes the lead, conversations, call records and campaign history. Can't be undone.</span>
                  </span>
                </button>
              ) : (
                <div className="p-3 rounded-xl border border-rose-500/30 bg-rose-500/5 space-y-2.5">
                  <p className="text-xs text-ink">Erase everything OmniReach holds on {lead.name || 'this lead'}? This can't be undone.</p>
                  <label className="flex items-start gap-2 text-[11px] text-ink-secondary">
                    <input type="checkbox" checked={keepBlocked} onChange={(e) => setKeepBlocked(e.target.checked)} className="mt-0.5" />
                    <span>Keep their number and email on the do-not-contact list, so they're never contacted again if re-imported (recommended).</span>
                  </label>
                  <div className="flex gap-2">
                    <button onClick={() => setConfirming(false)} disabled={!!busy} className="flex-1 py-2 rounded-lg border border-border-strong text-xs text-ink-secondary">
                      Cancel
                    </button>
                    <button
                      onClick={erase}
                      disabled={!!busy}
                      className="flex-1 py-2 rounded-lg bg-rose-500/80 hover:bg-rose-500 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5"
                    >
                      {busy === 'erase' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Erase permanently
                    </button>
                  </div>
                </div>
              )
            ) : (
              <p className="text-[11px] text-ink-muted">Only the workspace owner or an admin can erase a lead's data.</p>
            )}
            {error && <p className="text-[11px] text-rose-400">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
};
