import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, CalendarCheck2 } from 'lucide-react';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';

interface NotificationBellProps {
  userId?: string | null;
  onOpenInbox: () => void;
  /** 'left' when the bell sits near the left edge of the screen (the desktop sidebar
   * header) — anchoring the dropdown by its right edge there pushes it off the left of
   * the viewport instead of over visible content. Defaults to 'right' (the mobile top bar,
   * where the bell really is near the screen's right edge). */
  align?: 'left' | 'right';
}

interface NotificationEvent {
  id: string;
  leadName: string;
  channel: 'whatsapp' | 'email';
  at: string;
}

const SEEN_KEY = 'omnireach_notifications_last_seen_v1';

/**
 * Polls whatsapp_conversations/email_conversations for confirmed (booked) meetings only —
 * same 15s-poll pattern already used in DashboardView/CampaignAnalytics. "Unseen" is tracked
 * via a localStorage marker rather than a new table, since this is inherently per-browser,
 * per-viewer state.
 */
export const NotificationBell: React.FC<NotificationBellProps> = ({ userId, onOpenInbox, align = 'right' }) => {
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [open, setOpen] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState<string>(() => {
    if (typeof window === 'undefined') return new Date().toISOString();
    return localStorage.getItem(SEEN_KEY) || new Date(0).toISOString();
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isSupabaseBrowserConfigured || !supabase || !userId) return;

    const load = async () => {
      const [{ data: wa }, { data: em }] = await Promise.all([
        supabase!
          .from('whatsapp_conversations')
          .select('id, lead_name, last_message_at')
          .eq('org_id', userId)
          .eq('status', 'confirmed')
          .order('last_message_at', { ascending: false })
          .limit(10),
        supabase!
          .from('email_conversations')
          .select('id, lead_name, last_message_at')
          .eq('org_id', userId)
          .eq('status', 'confirmed')
          .order('last_message_at', { ascending: false })
          .limit(10),
      ]);
      if (cancelled) return;

      const toEvents = (rows: any[] | null, channel: 'whatsapp' | 'email'): NotificationEvent[] =>
        (rows || []).map((r) => ({
          id: `${channel}-${r.id}`,
          leadName: r.lead_name || 'A contact',
          channel,
          at: r.last_message_at,
        }));

      const merged = [...toEvents(wa, 'whatsapp'), ...toEvents(em, 'email')]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, 12);
      setEvents(merged);
    };

    load();
    const interval = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [userId]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const unseenCount = events.filter((e) => new Date(e.at).getTime() > new Date(lastSeenAt).getTime()).length;

  const handleToggle = () => {
    setOpen((v) => !v);
    if (!open) {
      const now = new Date().toISOString();
      setLastSeenAt(now);
      try {
        localStorage.setItem(SEEN_KEY, now);
      } catch {}
    }
  };

  if (!isSupabaseBrowserConfigured || !userId) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={handleToggle}
        className="relative p-2 rounded-lg text-ink-muted hover:bg-surface-hover transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unseenCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[#25D366] text-white text-[9px] font-bold flex items-center justify-center">
            {unseenCount > 9 ? '9+' : unseenCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className={`absolute top-full mt-1.5 w-72 max-w-[85vw] bg-surface/50 backdrop-blur-3xl border border-border rounded-xl shadow-elevated py-1.5 z-50 max-h-80 overflow-y-auto ${
              align === 'left' ? 'left-0 origin-top-left' : 'right-0 origin-top-right'
            }`}
          >
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Booked Meetings
            </div>
            {events.length === 0 ? (
              <p className="px-3 py-3 text-xs text-ink-muted">No meetings booked yet — they'll show up here.</p>
            ) : (
              events.map((e) => (
                <button
                  key={e.id}
                  onClick={() => {
                    onOpenInbox();
                    setOpen(false);
                  }}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-hover transition-colors"
                >
                  <CalendarCheck2 className="w-3.5 h-3.5 text-[#128C7E] mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-ink truncate">Meeting booked with {e.leadName}</p>
                    <p className="text-[10px] text-ink-muted">
                      {e.channel === 'whatsapp' ? 'WhatsApp' : 'Email'} • {new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </button>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
