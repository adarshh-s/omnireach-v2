import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, XCircle, RefreshCw, MessageSquare, KeyRound, Calendar, Mail, Reply } from 'lucide-react';

interface HealthStatus {
  ok: boolean;
  message: string;
}

interface HealthState {
  whatsappToken: HealthStatus;
  whatsapp: HealthStatus;
  calendar: HealthStatus;
  email: HealthStatus;
  emailReplyTracking: HealthStatus;
}

interface ChannelHealthPanelProps {
  accessToken?: string | null;
}

const ROWS: { key: keyof HealthState; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'whatsappToken', label: 'WhatsApp Access Token', icon: KeyRound },
  { key: 'whatsapp', label: 'WhatsApp Number', icon: MessageSquare },
  { key: 'calendar', label: 'Google Calendar', icon: Calendar },
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'emailReplyTracking', label: 'Email Reply Tracking', icon: Reply },
];

/**
 * Self-diagnosing status check — surfaces exactly the kind of failures (expired WhatsApp
 * token, disabled Calendar API, unverified email domain) that otherwise only show up after
 * a real lead's reply goes nowhere. Checked live against WhatsApp/Google/Resend, not just
 * "is a value present."
 */
export const ChannelHealthPanel: React.FC<ChannelHealthPanelProps> = ({ accessToken }) => {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    fetch(`/api/whatsapp/subscribe-app?action=health&_=${Date.now()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.whatsapp) setHealth(data);
        else setError('Could not run health checks.');
      })
      .catch(() => setError('Could not reach the server to run health checks.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  if (!accessToken) return null;

  return (
    <div className="p-4 bg-white rounded-xl border border-[#E4E4E7] space-y-2.5 hover:shadow-card transition-shadow duration-200">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-[#18181B]">Channel Health</span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="p-1 rounded-md text-[#71717A] hover:text-[#18181B] hover:bg-[#F4F4F5] transition-colors disabled:opacity-50"
          title="Re-check now"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-600">{error}</p>}

      {!error && (
        <div className="space-y-1.5">
          {ROWS.map(({ key, label, icon: Icon }) => {
            const status = health?.[key];
            return (
              <div key={key} className="flex items-start gap-2 text-[11px]">
                <Icon className="w-3.5 h-3.5 text-[#71717A] mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-[#3F3F46]">{label}</span>
                  {status && <span className="text-[#71717A]"> — {status.message}</span>}
                  {!status && loading && <span className="text-[#71717A]"> — checking...</span>}
                </div>
                <AnimatePresence mode="wait">
                  {status && (
                    <motion.span
                      key={status.ok ? 'ok' : 'fail'}
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.2, ease: [0.34, 1.56, 0.64, 1] }}
                      className="shrink-0"
                    >
                      {status.ok ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-[#25D366]" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-rose-500" />
                      )}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
