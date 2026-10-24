import { PageHeader } from './PageHeader';
import React, { useEffect, useRef, useState } from 'react';
import {
  MessageCircle,
  Phone,
  PhoneCall,
  Mail,
  Video,
  CheckCircle2,
  XCircle,
  UserCog,
  Clock,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { Lead } from '../types';

interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

interface RawConversation {
  id: string;
  phone?: string;
  client_email?: string;
  subject?: string;
  lead_id?: string;
  client_id?: string;
  campaign_recipient_id?: string;
  lead_name?: string;
  lead_email?: string;
  lead_company?: string;
  status: 'active' | 'confirmed' | 'declined' | 'handoff';
  history: ConversationTurn[];
  meeting_date?: string;
  meeting_time?: string;
  meet_link?: string;
  last_message_at: string;
  // Voice calls only (voice_calls table)
  call_status?: string;
  outcome?: string;
  direction?: 'inbound' | 'outbound';
  attempt?: number;
  followup_status?: string | null;
  next_retry_at?: string | null;
  followup_detail?: string | null;
  duration_seconds?: number;
  summary?: string;
  recording_url?: string;
  // Email only: the latest out-of-office / automatic reply (not counted as a reply)
  last_auto_reply_at?: string | null;
  last_auto_reply?: string | null;
}

interface UnifiedConversation extends RawConversation {
  channel: 'whatsapp' | 'email' | 'voice';
  contact: string;
}

interface ConversationsViewProps {
  leads: Lead[];
  onUpdateLead: (lead: Lead) => void;
  accessToken?: string | null;
}

const STATUS_STYLES: Record<RawConversation['status'], { label: string; className: string; icon: React.ComponentType<{ className?: string }> }> = {
  active: { label: 'In Conversation', className: 'bg-[#4285F4]/10 text-[#1E4FA6] border-[#4285F4]/30', icon: MessageCircle },
  confirmed: { label: 'Meeting Booked', className: 'bg-[#128C7E]/15 text-[#128C7E] border-[#128C7E]/30', icon: CheckCircle2 },
  declined: { label: 'Not Interested', className: 'bg-border-strong text-ink-muted border-border-strong', icon: XCircle },
  handoff: { label: 'Needs a Human', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30', icon: UserCog },
};

// A voice call without a booking has no conversation "status" worth showing — what matters
// is how the call itself went.
const CALL_OUTCOME_LABELS: Record<string, string> = {
  answered: 'Call Answered',
  'no-answer': 'No Answer',
  busy: 'Line Busy',
  voicemail: 'Voicemail',
  failed: 'Call Failed',
};

/** What happens next after an unanswered call (lib/voiceFollowUp.ts), in plain words. */
function followUpLabel(conv: UnifiedConversation): string | null {
  switch (conv.followup_status) {
    case 'retry_scheduled':
      return conv.next_retry_at
        ? `Calling again ${new Date(conv.next_retry_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
        : 'Calling again soon';
    case 'retrying':
      return 'Calling again now…';
    case 'retried':
      return 'Called again — see the newer call';
    case 'following_up':
      return 'Sending a follow-up message…';
    case 'fallback_whatsapp':
      return 'No answer after the last try — followed up on WhatsApp';
    case 'fallback_email':
      return 'No answer after the last try — followed up by email';
    case 'gave_up':
      return `No answer after the last try — couldn't send a follow-up${conv.followup_detail ? ` (${conv.followup_detail})` : ''}`;
    case 'stopped':
      return `Follow-up stopped${conv.followup_detail ? ` — ${conv.followup_detail}` : ''}`;
    default:
      return null;
  }
}

function voiceStatusStyle(conv: UnifiedConversation) {
  if (conv.status === 'confirmed') return STATUS_STYLES.confirmed;
  if (!conv.outcome) {
    const ringingLabel = conv.direction === 'inbound' ? 'Incoming…' : 'Calling…';
    return { label: conv.call_status === 'in-progress' ? 'On the Call' : ringingLabel, className: STATUS_STYLES.active.className, icon: PhoneCall };
  }
  return {
    label: CALL_OUTCOME_LABELS[conv.outcome] || 'Call Ended',
    className: conv.outcome === 'answered' ? STATUS_STYLES.active.className : STATUS_STYLES.declined.className,
    icon: PhoneCall,
  };
}

function formatDuration(seconds?: number): string | null {
  if (seconds == null) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const ConversationsView: React.FC<ConversationsViewProps> = ({ leads, onUpdateLead, accessToken }) => {
  const [conversations, setConversations] = useState<UnifiedConversation[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [unplayableRecordings, setUnplayableRecordings] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const syncedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    const fetchConversations = async () => {
      if (!accessToken) {
        if (!cancelled) {
          setConfigured(false);
          setLoading(false);
        }
        return;
      }
      try {
        const headers = { Authorization: `Bearer ${accessToken}` };
        const [waRes, emRes, vcRes] = await Promise.all([
          fetch('/api/conversations?channel=whatsapp', { headers }),
          fetch('/api/conversations?channel=email', { headers }),
          fetch('/api/conversations?channel=voice', { headers }),
        ]);
        // Voice is tolerated failing on its own (e.g. voice_calls not migrated yet) so it
        // never takes the WhatsApp/Email inbox down with it.
        const [waData, emData, vcData] = await Promise.all([waRes.json(), emRes.json(), vcRes.json().catch(() => ({}))]);
        if (cancelled) return;

        setConfigured(!!waData.configured || !!emData.configured);

        const waConvs: UnifiedConversation[] = (Array.isArray(waData.conversations) ? waData.conversations : []).map(
          (c: RawConversation) => ({ ...c, channel: 'whatsapp' as const, contact: c.phone || '' })
        );
        const emConvs: UnifiedConversation[] = (Array.isArray(emData.conversations) ? emData.conversations : []).map(
          (c: RawConversation) => ({ ...c, channel: 'email' as const, contact: c.client_email || '' })
        );

        const vcConvs: UnifiedConversation[] = (Array.isArray(vcData.conversations) ? vcData.conversations : []).map(
          (c: RawConversation) => ({ ...c, channel: 'voice' as const, contact: c.phone || '' })
        );

        const merged = [...waConvs, ...emConvs, ...vcConvs].sort(
          (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
        );
        setConversations(merged);
      } catch {
        if (!cancelled) setConfigured(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchConversations();
    const interval = setInterval(fetchConversations, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [accessToken]);

  // Sync confirmed bookings back into the Leads table (matched by phone or email).
  useEffect(() => {
    conversations.forEach((conv) => {
      if (conv.status !== 'confirmed' || !conv.meeting_date) return;
      if (syncedIdsRef.current.has(conv.id)) return;

      const matchedLead =
        conv.channel !== 'email'
          ? leads.find((l) => {
              const convDigits = (conv.contact || '').replace(/\D/g, '');
              const leadDigits = (l.phone || '').replace(/\D/g, '');
              // An empty/too-short number "endsWith" matches everything — without this guard a
              // lead with no phone got another lead's booked meeting written onto it.
              if (convDigits.length < 7 || leadDigits.length < 7) return false;
              return leadDigits.endsWith(convDigits) || convDigits.endsWith(leadDigits);
            })
          : leads.find((l) => !!l.email && !!conv.contact && l.email.toLowerCase() === conv.contact.toLowerCase());

      // No match yet doesn't necessarily mean "no such lead" — on first load this effect
      // can run before the `leads` prop has finished loading from the cloud, and marking
      // synced unconditionally here would permanently skip this conversation on every
      // future poll too, even once `leads` arrives. Only mark synced once a lead was
      // actually found, so an unlucky load-order race gets retried on the next 8s poll
      // instead of silently leaving a confirmed meeting stuck as "Pending" forever.
      if (!matchedLead) return;

      if (matchedLead.status !== 'Meeting Scheduled') {
        onUpdateLead({
          ...matchedLead,
          status: 'Meeting Scheduled',
          meetingDate: conv.meeting_date,
          meetingTime: conv.meeting_time,
          notes: conv.meet_link
            ? `${matchedLead.notes ? matchedLead.notes + '\n' : ''}Booked via AI ${conv.channel === 'whatsapp' ? 'WhatsApp' : conv.channel === 'voice' ? 'Voice' : 'Email'} bot — Meet link: ${conv.meet_link}`
            : matchedLead.notes,
        });
      }
      syncedIdsRef.current.add(conv.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  if (loading) {
    return (
      <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-10 shadow-card text-center text-sm text-ink-muted">
        <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-[#128C7E]" />
        Loading AI conversations…
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-8 shadow-card">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h3 className="font-semibold text-sm text-ink">
              {accessToken ? 'AI Booking Bot not configured yet' : 'Sign in to view the AI Inbox'}
            </h3>
            <p className="text-xs text-ink-secondary mt-1.5 leading-relaxed max-w-xl">
              This panel shows live WhatsApp and Email conversations the AI bot is handling — replying to prospects,
              gathering answers, and booking real Google Calendar meetings when a time is confirmed. This workspace
              hasn't finished connecting the AI Inbox yet — ask your workspace admin to complete setup in{' '}
              <span className="font-medium text-ink">Channel Setup</span>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Inbox"
        description="Every WhatsApp, email and call conversation the AI is handling — it replies, finds a time and books the meeting."
        actions={
          <span className="text-xs text-ink-muted flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#25D366] animate-pulse" />
            Live
          </span>
        }
      />

      {conversations.length === 0 ? (
        <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-10 shadow-card text-center text-sm text-ink-muted">
          No conversations yet. They show up here as soon as a lead replies or the AI places a call.
        </div>
      ) : (
        <div className="space-y-3">
          {conversations.map((conv) => {
            const style = conv.channel === 'voice' ? voiceStatusStyle(conv) : STATUS_STYLES[conv.status] || STATUS_STYLES.active;
            const StatusIcon = style.icon;
            const isExpanded = expandedId === conv.id;
            const lastTurn = conv.history?.[conv.history.length - 1];
            const ChannelIcon = conv.channel === 'whatsapp' ? Phone : conv.channel === 'voice' ? PhoneCall : Mail;
            const channelTint =
              conv.channel === 'whatsapp'
                ? { bg: 'bg-[#25D366]/10', fg: 'text-[#128C7E]' }
                : conv.channel === 'voice'
                  ? { bg: 'bg-violet-500/10', fg: 'text-violet-400' }
                  : { bg: 'bg-[#4285F4]/10', fg: 'text-[#4285F4]' };

            return (
              <div
                key={`${conv.channel}-${conv.id}`}
                className="bg-surface/50 backdrop-blur-3xl border border-border rounded-[20px] shadow-sm overflow-hidden hover:border-[#128C7E]/40 transition-all"
              >
                <button
                  className="w-full text-left p-4 flex items-start justify-between gap-4"
                  onClick={() => setExpandedId(isExpanded ? null : conv.id)}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${channelTint.bg}`}
                    >
                      <ChannelIcon className={`w-4 h-4 ${channelTint.fg}`} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-ink">
                          {conv.lead_name || 'Unknown Contact'}
                        </span>
                        {conv.lead_company && <span className="text-xs text-ink-muted">• {conv.lead_company}</span>}
                        {conv.campaign_recipient_id && (
                          <span className="text-[10px] text-ink-muted bg-surface-hover border border-border px-1.5 py-0.5 rounded-full">
                            From campaign
                          </span>
                        )}
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold border flex items-center gap-1 ${style.className}`}
                        >
                          <StatusIcon className="w-3 h-3" />
                          {style.label}
                        </span>
                      </div>
                      <div className="text-xs text-ink-muted mt-0.5 font-mono">
                        {conv.channel === 'whatsapp' ? `+${conv.contact}` : conv.contact}
                        {conv.channel === 'voice' && conv.direction === 'inbound' && (
                          <span className="ml-2 font-sans">• Called in</span>
                        )}
                        {conv.channel === 'voice' && (conv.attempt || 1) > 1 && <span className="ml-2 font-sans">• Try {conv.attempt}</span>}
                        {conv.channel === 'voice' && formatDuration(conv.duration_seconds) && (
                          <span className="ml-2 font-sans">• {formatDuration(conv.duration_seconds)}</span>
                        )}
                      </div>
                      {conv.channel === 'email' && conv.last_auto_reply_at && (
                        <p className="text-[11px] text-ink-muted mt-1 truncate max-w-lg" title={conv.last_auto_reply || undefined}>
                          Automatic reply {new Date(conv.last_auto_reply_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                          {conv.last_auto_reply ? ` — ${conv.last_auto_reply}` : ''}
                        </p>
                      )}
                      {conv.channel === 'voice' && followUpLabel(conv) && (
                        <p className="text-[11px] text-ink-muted mt-1" title={conv.followup_detail || undefined}>
                          {followUpLabel(conv)}
                        </p>
                      )}
                      {lastTurn && (
                        <p className="text-xs text-ink-secondary mt-1.5 truncate max-w-lg">
                          <span className="font-medium">{lastTurn.role === 'user' ? 'Them: ' : 'Bot: '}</span>
                          {lastTurn.text}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 flex-shrink-0">
                    {conv.status === 'confirmed' && conv.meeting_date && (
                      <div className="text-right text-xs">
                        <div className="flex items-center gap-1 text-[#128C7E] font-semibold justify-end">
                          <Clock className="w-3 h-3" />
                          {conv.meeting_date} {conv.meeting_time}
                        </div>
                        {conv.meet_link && (
                          <a
                            href={conv.meet_link}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1 text-[#4285F4] hover:underline justify-end mt-0.5"
                          >
                            <Video className="w-3 h-3" />
                            Meet Link
                          </a>
                        )}
                      </div>
                    )}
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-ink-muted" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-ink-muted" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-border bg-canvas p-4 space-y-2 max-h-80 overflow-y-auto">
                    {conv.subject && <p className="text-[11px] text-ink-muted font-medium mb-1">Subject: {conv.subject}</p>}
                    {conv.summary && (
                      <p className="text-xs text-ink-secondary leading-relaxed mb-2">
                        <span className="font-semibold text-ink">Call summary: </span>
                        {conv.summary}
                      </p>
                    )}
                    {conv.recording_url &&
                      (unplayableRecordings.has(conv.recording_url) ? (
                        <p className="text-[11px] text-ink-muted mb-2">
                          Recording not available — the voice provider is keeping it private. The transcript is below.
                        </p>
                      ) : (
                        // metadata (not none) so a recording that can't be fetched is caught when the
                        // conversation opens, instead of leaving a player that silently does nothing.
                        <audio
                          controls
                          preload="metadata"
                          src={conv.recording_url}
                          onError={() => setUnplayableRecordings((prev) => new Set(prev).add(conv.recording_url!))}
                          className="w-full h-9 mb-2"
                        />
                      ))}
                    {conv.channel === 'voice' && (conv.history || []).length === 0 && (
                      <p className="text-xs text-ink-muted">
                        {conv.outcome ? 'No conversation was recorded on this call.' : 'The transcript appears here when the call ends.'}
                      </p>
                    )}
                    {(conv.history || []).map((turn, idx) => (
                      <div
                        key={idx}
                        className={`flex ${turn.role === 'user' ? 'justify-start' : 'justify-end'}`}
                      >
                        <div
                          className={`max-w-[75%] px-3.5 py-2 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap ${
                            turn.role === 'user'
                              ? 'bg-surface border border-border text-ink'
                              : 'bg-[#25D366]/10 border border-[#25D366]/30 text-emerald-300'
                          }`}
                        >
                          {turn.text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
