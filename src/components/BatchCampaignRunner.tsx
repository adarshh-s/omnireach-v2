import React, { useState, useEffect, useRef, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Play,
  Pause,
  RotateCcw,
  Upload,
  Send,
  MessageSquare,
  Mail,
  CheckCircle2,
  Clock,
  ExternalLink,
  Sparkles,
  Settings,
  Layers,
  ChevronRight,
  AlertCircle,
  Phone,
  Loader2,
} from 'lucide-react';
import {
  Lead,
  CalendarSlot,
  CampaignSettings,
  MessageTemplate,
  ChannelApiSettings,
  OutreachDispatchLog,
} from '../types';
import {
  generateAIPersonalizedMessage,
  interpolateTemplate,
  resolveTemplateVariables,
  generateWhatsAppLink,
  generateMailtoLink,
} from '../utils/outreachEngine';
import { sendEmailDirectOrBackend } from '../services/emailService';
import { hasChannelSecret } from '../utils/channelSecrets';
import { useOrgVoice } from '../hooks/useOrgVoice';
import { DEFAULT_TEMPLATES } from '../data/sampleTemplates';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';
import { computeNextPeakSendTime } from '../../lib/countryTiming';
import { AdvancedSection } from './AdvancedSection';
import { VoiceDemoWidget } from './VoiceDemoWidget';
import { PageHeader, headerPrimaryButton, headerSecondaryButton } from './PageHeader';
import type { QueueStatus } from '../../lib/callQueue';
import type { MessageCampaignStatus } from '../../lib/messageQueue';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Counts WhatsApp sends already used up today across every campaign for this org — not
 * just the one currently being launched. Without this, the safe-daily-limit safeguard only
 * protects a single campaign launch: two separate 200-lead campaigns run back to back would
 * each think they're under a 250 cap and both send in full, 400 total, silently over the
 * real limit. Counts anything already dispatched today (Sent/Delivered/Failed) plus anything
 * still Queued but scheduled to go out later today (from this or an earlier campaign) —
 * both consume today's budget.
 */
// Saved secrets never come back to the browser, so "configured" means typed or saved
// (hasChannelSecret) rather than present in channelSettings.
function isWhatsAppApiReady(s: ChannelApiSettings): boolean {
  return (
    (s.whatsAppProvider === 'twilio' && !!s.twilioAccountSid && hasChannelSecret(s, 'twilioAuthToken')) ||
    (s.whatsAppProvider === 'cloud_api' && hasChannelSecret(s, 'whatsappCloudApiKey') && !!s.whatsappCloudPhoneId) ||
    (s.whatsAppProvider === 'webhook' && !!s.n8nWebhookUrl)
  );
}

// 'resend' needs no org-supplied key — lib/emailSender.ts falls back to the platform's own
// shared account. Gmail/Outlook count once picked; the server reports if the mailbox isn't
// connected (Channel Setup shows the connection itself).
function isEmailApiReady(s: ChannelApiSettings): boolean {
  return (
    s.emailProvider === 'resend' ||
    s.emailProvider === 'gmail' ||
    s.emailProvider === 'outlook' ||
    ((s.emailProvider === 'sendgrid' || s.emailProvider === 'mailgun') && hasChannelSecret(s, 'emailApiKey')) ||
    (s.emailProvider === 'smtp' && !!s.smtpHost && !!s.smtpUser && hasChannelSecret(s, 'smtpPass'))
  );
}

async function fetchTodaysWhatsAppVolumeUsed(userId: string): Promise<number> {
  if (!isSupabaseBrowserConfigured || !supabase) return 0;
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const startIso = startOfToday.toISOString();
  const endIso = startOfTomorrow.toISOString();

  try {
    const { count } = await supabase
      .from('campaign_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', userId)
      .or(
        `and(whatsapp_status.in.(Sent,Delivered,Failed),updated_at.gte.${startIso},updated_at.lt.${endIso}),and(whatsapp_status.eq.Queued,scheduled_for.gte.${startIso},scheduled_for.lt.${endIso})`
      );
    return count || 0;
  } catch {
    return 0;
  }
}

interface BatchCampaignRunnerProps {
  leads: Lead[];
  availableSlots: CalendarSlot[];
  campaignSettings: CampaignSettings;
  channelSettings: ChannelApiSettings;
  templates: MessageTemplate[];
  accessToken?: string | null;
  userId?: string | null;
  onUpdateLead: (lead: Lead) => void;
  onUpdateSettings?: (settings: CampaignSettings) => void;
  onResetAllLeadsToPending?: () => void;
  onBookCalendarSlot?: (slotId: string, lead: Lead, notes: string) => void;
  onOpenChannelConfig: () => void;
  onOpenExcelUpload: () => void;
  onSelectLeadForSimulator?: (leadId: string) => void;
}

export const BatchCampaignRunner: React.FC<BatchCampaignRunnerProps> = ({
  leads,
  availableSlots,
  campaignSettings,
  channelSettings,
  templates,
  accessToken,
  userId,
  onUpdateLead,
  onUpdateSettings,
  onResetAllLeadsToPending,
  onOpenChannelConfig,
  onOpenExcelUpload,
  onSelectLeadForSimulator,
}) => {
  const orgVoice = useOrgVoice(userId, accessToken ?? null);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [channelMode, setChannelMode] = useState<'omnichannel' | 'whatsapp' | 'email' | 'voice'>(
    campaignSettings.channelMode || 'omnichannel'
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    templates[0]?.id || 'tpl-1'
  );
  const [delaySeconds, setDelaySeconds] = useState<number>(campaignSettings.delayBetweenMessagesSeconds || 2);
  const [autoOpenApps, setAutoOpenApps] = useState<boolean>(false);
  const [usePeakScheduling, setUsePeakScheduling] = useState<boolean>(false);
  
  // Real-time live dispatch previews
  const [currentLead, setCurrentLead] = useState<Lead | null>(null);
  const [currentWhatsAppText, setCurrentWhatsAppText] = useState<string>('');
  const [currentEmailSubject, setCurrentEmailSubject] = useState<string>('');
  const [currentEmailBody, setCurrentEmailBody] = useState<string>('');
  const [isProcessingStep, setIsProcessingStep] = useState<boolean>(false);
  // Kept in this browser (per workspace) so a refresh doesn't wipe the run's activity; Reset clears it.
  const activityStorageKey = `omnireach_campaign_activity_v1_${userId || 'local'}`;
  const [dispatchLogs, setDispatchLogs] = useState<OutreachDispatchLog[]>(() => {
    try {
      const saved = localStorage.getItem(activityStorageKey);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(activityStorageKey, JSON.stringify(dispatchLogs));
    } catch {}
  }, [dispatchLogs, activityStorageKey]);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [showBulkSendConfirm, setShowBulkSendConfirm] = useState(false);
  const [bulkSendInfo, setBulkSendInfo] = useState<{
    count: number;
    safeDailyLimit: number;
    isTemplateMode: boolean;
    usedToday: number;
  } | null>(null);

  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  // Persisted campaign tracking (Supabase) — id of the campaign row created when this
  // run launched, and a lookup from client (lead) id to its campaign_recipients row id,
  // so per-lead status updates below can also update the persisted recipient record.
  const currentCampaignIdRef = useRef<string | null>(null);
  const recipientIdByClientRef = useRef<Record<string, string>>({});
  // Counts every lead that goes through the WhatsApp channel this run (sent or deferred),
  // in dispatch order — used to auto-split a batch larger than the safe daily limit across
  // multiple days instead of sending it all at once. See handleStart's confirmation check
  // and the deferral block in processNextLead below. Initialized from
  // todaysWhatsAppVolumeUsedRef (not 0) so it accounts for volume already used today by
  // other campaigns, not just this one.
  const whatsappVolumeIndexRef = useRef(0);
  const todaysWhatsAppVolumeUsedRef = useRef(0);

  const pendingLeads = leads.filter(
    (l) =>
      l.status === 'Pending' ||
      (channelMode === 'whatsapp' && l.whatsAppStatus === 'Pending') ||
      (channelMode === 'email' && l.emailStatus === 'Pending') ||
      (channelMode === 'voice' && (l.voiceCallStatus || 'Pending') === 'Pending')
  );

  const completedWhatsAppCount = leads.filter((l) => l.whatsAppStatus !== 'Pending').length;
  const completedEmailCount = leads.filter((l) => l.emailStatus !== 'Pending').length;
  const bookedCount = leads.filter((l) => l.status === 'Meeting Scheduled').length;
  const totalLeadsCount = leads.length;

  const channelModeLabel =
    channelMode === 'omnichannel' ? 'WhatsApp & Email' : channelMode === 'voice' ? 'AI Voice Agent' : channelMode === 'whatsapp' ? 'WhatsApp' : 'Email';

  // How many contacts actually failed on the channel(s) this run used — "no longer Pending"
  // doesn't mean "succeeded" (a Failed status also drops a lead out of pendingLeads), so the
  // "Campaign Complete" banner needs this to avoid calling a run a success when every send
  // or call actually failed.
  const failedForChannelCount = leads.filter((l) => {
    if (channelMode === 'whatsapp') return l.whatsAppStatus === 'Failed';
    if (channelMode === 'email') return l.emailStatus === 'Failed';
    if (channelMode === 'voice') return l.voiceCallStatus === 'Failed';
    if (channelMode === 'omnichannel') return l.whatsAppStatus === 'Failed' || l.emailStatus === 'Failed';
    return false;
  }).length;
  const engagedCount = totalLeadsCount - failedForChannelCount;

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || templates[0];

  // A static, non-AI preview of the very next contact this run would reach — lets someone
  // check what's about to go out before committing to "Launch Campaign", instead of only
  // finding out once the run is already underway. Deliberately skips the AI rewrite (which
  // costs a real API call) since this is just for a quick sanity check, not the final copy.
  const previewLead = !isRunning ? pendingLeads[0] : undefined;
  const previewContent = useMemo(() => {
    if (!previewLead || !selectedTemplate) return null;
    return {
      whatsApp: interpolateTemplate(selectedTemplate.whatsAppContent || '', previewLead, campaignSettings, availableSlots),
      emailSubject: interpolateTemplate(selectedTemplate.emailSubject || '', previewLead, campaignSettings, availableSlots),
      emailBody: interpolateTemplate(selectedTemplate.emailBody || '', previewLead, campaignSettings, availableSlots),
    };
  }, [previewLead, selectedTemplate, campaignSettings, availableSlots]);

  // One-off AI voice call to whichever lead is currently shown in the preview panel
  // (the live one mid-run, or the "next up" one when idle) — mirrors the same button in
  // MessageSimulator.tsx so a batch operator can jump straight to calling without leaving this page.
  const [isCalling, setIsCalling] = useState(false);
  const [callResult, setCallResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleCallLead = async (lead: Lead) => {
    if (!lead?.phone) return;
    setIsCalling(true);
    setCallResult(null);
    try {
      const res = await fetch('/api/voice/vapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({ phone: lead.phone, name: lead.name, clientId: lead.id, country: lead.country, variables: { company: lead.company || '' } }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setCallResult({ ok: true, message: `Calling ${lead.name} now — call ID ${data.callId || ''}.` });
      } else {
        setCallResult({ ok: false, message: data.error || 'Could not start the call.' });
      }
    } catch (err: any) {
      setCallResult({ ok: false, message: err?.message || 'Failed to reach the server.' });
    } finally {
      setIsCalling(false);
    }
  };

  // ---- Voice campaigns run on the server's call queue (lib/callQueue.ts), not this loop ----
  // Calls overlap (each lasts minutes), so dialling every few seconds from the browser would
  // pile up dozens at once and stop if the tab closed. The queue calls in batches, a few at
  // a time, during each lead's business hours, and keeps going with the browser closed.
  const [voiceBatchSize, setVoiceBatchSize] = useState(50);
  const [voiceConcurrency, setVoiceConcurrency] = useState(2);
  const [voiceBatchGap, setVoiceBatchGap] = useState(30);
  const [callQueue, setCallQueue] = useState<QueueStatus | null>(null);
  const [queueNote, setQueueNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const queueActive = !!callQueue?.campaign && ['running', 'paused'].includes(callQueue.campaign.status);

  const loadQueueStatus = async () => {
    if (!accessToken) return;
    try {
      const res = await fetch('/api/voice/vapi?action=queue-status', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.ok) setCallQueue(await res.json());
    } catch {
      // Keep the last known status; the next poll tries again.
    }
  };

  useEffect(() => {
    if (channelMode !== 'voice' || !accessToken) return;
    loadQueueStatus();
    if (!queueActive) return;
    const timer = setInterval(loadQueueStatus, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelMode, accessToken, queueActive]);

  // Mirror the queue onto each lead's call status, so the Leads page and progress match it.
  useEffect(() => {
    if (!callQueue?.items?.length) return;
    const desired: Record<string, Lead['voiceCallStatus']> = {
      queued: 'Queued',
      calling: 'Sent',
      done: 'Sent',
      failed: 'Failed',
      cancelled: 'Pending',
    };
    for (const item of callQueue.items) {
      const next = desired[item.status];
      const lead = item.clientId ? leads.find((l) => l.id === item.clientId) : undefined;
      if (lead && next && lead.voiceCallStatus !== next) onUpdateLead({ ...lead, voiceCallStatus: next });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callQueue]);

  const startVoiceQueue = async () => {
    if (!accessToken) {
      setQueueNote({ ok: false, text: 'Sign in to run a call campaign.' });
      return;
    }
    const toCall = pendingLeads.filter((l) => l.isValidPhone && l.phone);
    if (toCall.length === 0) {
      setQueueNote({ ok: false, text: 'No leads with a valid phone number are waiting to be called.' });
      return;
    }
    setQueueBusy(true);
    setQueueNote(null);
    try {
      const res = await fetch('/api/voice/vapi?action=queue-calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          leads: toCall.map((l) => ({ clientId: l.id, name: l.name, phone: l.phone, country: l.country })),
          batchSize: voiceBatchSize,
          concurrency: voiceConcurrency,
          batchGapMinutes: voiceBatchGap,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setQueueNote({ ok: false, text: data.error || 'Could not start the call campaign.' });
        return;
      }
      if (data.status) setCallQueue(data.status);
      const skipped: { name: string; reason: string }[] = data.skipped || [];
      const reasons = Object.entries(
        skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] || 0) + 1 }), {})
      )
        .map(([reason, n]) => `${n} ${reason}`)
        .join(', ');
      setQueueNote({
        ok: data.queued > 0,
        text:
          data.queued > 0
            ? `Queued ${data.queued} call${data.queued === 1 ? '' : 's'}. You can close this page — calls keep going.${skipped.length ? ` Skipped ${skipped.length}: ${reasons}.` : ''}`
            : `Nothing to call. Skipped ${skipped.length}: ${reasons}.`,
      });
    } catch (err: any) {
      setQueueNote({ ok: false, text: err?.message || 'Failed to reach the server.' });
    } finally {
      setQueueBusy(false);
    }
  };

  const controlVoiceQueue = async (control: 'pause' | 'resume' | 'cancel') => {
    if (!accessToken) return;
    if (control === 'cancel' && !window.confirm('Cancel the remaining calls? Calls already in progress will finish.')) return;
    setQueueBusy(true);
    try {
      const res = await fetch('/api/voice/vapi?action=queue-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ control }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.status) setCallQueue(data.status);
    } finally {
      setQueueBusy(false);
    }
  };

  // ---- WhatsApp/email campaigns run on the server too (lib/messageQueue.ts) ----
  // Whenever the server can send them — i.e. not manual WhatsApp, which opens chats in the
  // user's own app and so has to run here. The open page nudges the queue every few seconds;
  // with the page closed, the scheduled dispatcher keeps it going.
  const involvesWhatsAppChannel = channelMode === 'omnichannel' || channelMode === 'whatsapp';
  const useServerMessages =
    isSupabaseBrowserConfigured && !!accessToken && channelMode !== 'voice' && (!involvesWhatsAppChannel || isWhatsAppApiReady(channelSettings));
  const [msgQueue, setMsgQueue] = useState<MessageCampaignStatus | null>(null);
  const [msgNote, setMsgNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [msgBusy, setMsgBusy] = useState(false);
  // "In progress" means first messages still going out — scheduled follow-ups days later run
  // on the server and shouldn't block starting the next campaign.
  const msgActive =
    !!msgQueue?.campaign &&
    (msgQueue.campaign.status === 'paused' || (msgQueue.campaign.status === 'running' && (msgQueue.initialWaiting ?? 0) > 0));
  const [followupDays, setFollowupDays] = useState(0);
  const [followupTemplateId, setFollowupTemplateId] = useState<string>(
    () => templates.find((t) => /follow/i.test(t.name))?.id || templates[0]?.id || ''
  );
  const pumpInFlight = useRef(false);

  const campaignApi = async (action: string, body?: Record<string, unknown>) => {
    const res = await fetch(`/api/outreach/send-whatsapp?action=${action}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  };

  useEffect(() => {
    if (channelMode === 'voice' || !accessToken || !isSupabaseBrowserConfigured) return;
    campaignApi('campaign-status').then(({ ok, data }) => ok && setMsgQueue(data)).catch(() => {});
    if (!msgActive) return;
    const timer = setInterval(async () => {
      if (pumpInFlight.current) return;
      pumpInFlight.current = true;
      try {
        // Paused campaigns only need their status refreshed, not a send.
        const { ok, data } = await campaignApi(msgQueue?.campaign?.status === 'paused' ? 'campaign-status' : 'campaign-pump', msgQueue?.campaign?.status === 'paused' ? undefined : {});
        if (ok) setMsgQueue(data);
      } catch {
        // Try again on the next tick.
      } finally {
        pumpInFlight.current = false;
      }
    }, 8000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelMode, accessToken, msgActive, msgQueue?.campaign?.status]);

  // Mirror the server's per-lead statuses onto the leads shown here.
  useEffect(() => {
    if (!msgQueue?.items?.length) return;
    for (const item of msgQueue.items) {
      const lead = leads.find((l) => l.id === item.clientId);
      if (!lead) continue;
      const wa = item.whatsappStatus as Lead['whatsAppStatus'];
      const em = item.emailStatus as Lead['emailStatus'];
      if (lead.whatsAppStatus === wa && lead.emailStatus === em) continue;
      const contacted = ['Sent', 'Delivered', 'Read'].includes(wa) || em === 'Sent';
      onUpdateLead({ ...lead, whatsAppStatus: wa, emailStatus: em, ...(contacted && lead.status === 'Pending' ? { status: 'Contacted' } : {}) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgQueue]);

  const startMessageQueue = async () => {
    setMsgBusy(true);
    setMsgNote(null);
    try {
      const { ok, data } = await campaignApi('queue-campaign', {
        clientIds: pendingLeads.map((l) => l.id),
        channels: channelMode === 'omnichannel' ? ['whatsapp', 'email'] : [channelMode],
        template: {
          whatsAppContent: selectedTemplate?.whatsAppContent || '',
          emailSubject: selectedTemplate?.emailSubject || '',
          emailBody: selectedTemplate?.emailBody || '',
        },
        useAi: !!campaignSettings.useAiCopywriting,
        peakScheduling: usePeakScheduling,
        sendGapSeconds: delaySeconds,
        templateName: selectedTemplate?.name || null,
        followupDays: followupDays || null,
        followupTemplate: followupDays
          ? (({ whatsAppContent, emailSubject, emailBody }) => ({ whatsAppContent, emailSubject, emailBody }))(
              templates.find((t) => t.id === followupTemplateId) || selectedTemplate || ({} as MessageTemplate)
            )
          : null,
      });
      if (!ok || !data.ok) {
        setMsgNote({ ok: false, text: data.error || 'Could not start the campaign.' });
        return;
      }
      if (data.status) setMsgQueue(data.status);
      const skipped: { name: string; reason: string }[] = data.skipped || [];
      const reasons = Object.entries(skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] || 0) + 1 }), {}))
        .map(([reason, n]) => `${n} ${reason}`)
        .join(', ');
      setMsgNote({
        ok: data.queued > 0,
        text:
          data.queued > 0
            ? `Started for ${data.queued} lead${data.queued === 1 ? '' : 's'} — you can close this page, sending carries on.${
                data.laterDays ? ` Your daily WhatsApp limit spreads this over ${data.laterDays + 1} days.` : ''
              }${skipped.length ? ` Skipped ${skipped.length}: ${reasons}.` : ''}`
            : `Nothing to send. Skipped ${skipped.length}: ${reasons}.`,
      });
    } catch (err: any) {
      setMsgNote({ ok: false, text: err?.message || 'Failed to reach the server.' });
    } finally {
      setMsgBusy(false);
    }
  };

  const controlMessageQueue = async (control: 'pause' | 'resume' | 'cancel') => {
    if (control === 'cancel' && !window.confirm('Cancel the messages that haven’t gone out yet?')) return;
    setMsgBusy(true);
    try {
      const { data } = await campaignApi('campaign-control', { control });
      if (data.status) setMsgQueue(data.status);
    } finally {
      setMsgBusy(false);
    }
  };

  // Campaign Execution Loop
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const processNextLead = async () => {
      if (!isRunningRef.current || isPausedRef.current) return;

      // Find next pending lead
      const nextPendingIndex = leads.findIndex(
        (l, idx) =>
          idx >= currentIndex &&
          (l.status === 'Pending' ||
            (channelMode === 'whatsapp' && l.whatsAppStatus === 'Pending') ||
            (channelMode === 'email' && l.emailStatus === 'Pending') ||
            (channelMode === 'voice' && (l.voiceCallStatus || 'Pending') === 'Pending') ||
            (channelMode === 'omnichannel' && (l.whatsAppStatus === 'Pending' || l.emailStatus === 'Pending')))
      );

      if (nextPendingIndex === -1) {
        setIsRunning(false);
        setIsProcessingStep(false);
        setCurrentLead(null);
        return;
      }

      const lead = leads[nextPendingIndex];
      setCurrentIndex(nextPendingIndex);
      setCurrentLead(lead);
      setIsProcessingStep(true);

      // 1. Build the outbound message: either AI-personalized, or the template exactly as typed
      // (skipped entirely for voice — the Vapi assistant speaks its own script, no template
      // text to generate, and skipping avoids burning an AI call for nothing).
      const personalized = channelMode === 'voice'
        ? { whatsApp: '', emailSubject: '', emailBody: '' }
        : campaignSettings.useAiCopywriting
          ? await generateAIPersonalizedMessage(lead, campaignSettings, selectedTemplate, availableSlots, accessToken)
          : {
              whatsApp: interpolateTemplate(selectedTemplate?.whatsAppContent || '', lead, campaignSettings, availableSlots),
              emailSubject: interpolateTemplate(selectedTemplate?.emailSubject || '', lead, campaignSettings, availableSlots),
              emailBody: interpolateTemplate(selectedTemplate?.emailBody || '', lead, campaignSettings, availableSlots),
            };

      setCurrentWhatsAppText(personalized.whatsApp);
      setCurrentEmailSubject(personalized.emailSubject);
      setCurrentEmailBody(personalized.emailBody);

      // Computed once, used by both the immediate-send path below and the peak-time
      // scheduling path (which needs it stored for the headless dispatcher).
      const useTemplate =
        (channelMode === 'omnichannel' || channelMode === 'whatsapp') &&
        (channelSettings.whatsAppProvider === 'twilio' || channelSettings.whatsAppProvider === 'cloud_api') &&
        channelSettings.whatsappMessageMode === 'template';
      const templateParams = useTemplate
        ? resolveTemplateVariables(
            (channelSettings.whatsAppProvider === 'twilio'
              ? channelSettings.twilioContentVariables
              : channelSettings.whatsappTemplateVariables) || [],
            lead,
            campaignSettings,
            availableSlots
          )
        : undefined;
      // Leave this undefined (never hardcode 'onboarding@resend.dev' here) when there's no
      // real address to prefer — sendEmailViaOrgProvider (lib/emailSender.ts) already picks
      // the correct platform address itself via RESEND_FROM_ADDRESS (the org's verified
      // domain), which this used to short-circuit and force the sandbox sender instead,
      // even when a verified domain was configured server-side.
      const resolvedSenderEmail =
        channelSettings.smtpFromEmail ||
        (campaignSettings.senderEmail && !campaignSettings.senderEmail.includes('.example')
          ? campaignSettings.senderEmail
          : undefined);

      // WhatsApp daily volume cap: Meta caps unique conversations per rolling 24h based on
      // the number's messaging tier (see ChannelConfigModal's "Safe Daily Send Limit").
      // Every lead that goes through WhatsApp this run advances a running counter; once it
      // crosses the limit, this lead (and the rest) get pushed to a later day instead of
      // blasted today and risking the number's quality rating / an outright ban.
      const whatsappRelevantForLead =
        (channelMode === 'omnichannel' || channelMode === 'whatsapp') &&
        lead.whatsAppStatus === 'Pending' &&
        lead.isValidPhone;
      const safeDailyLimit = channelSettings.safeDailyWhatsAppLimit || 250;
      let volumeDayOffset = 0;
      if (whatsappRelevantForLead) {
        volumeDayOffset = Math.floor(whatsappVolumeIndexRef.current / safeDailyLimit);
        whatsappVolumeIndexRef.current += 1;
      }
      const needsVolumeDefer = volumeDayOffset > 0;

      // Country peak-time scheduling: if enabled and it isn't currently peak local time
      // for this lead's country, don't send now — persist it as Queued (with the
      // already-generated message content) for the headless dispatcher
      // (api/cron/dispatch-scheduled.ts) to send later, and move straight to the next lead.
      // Composes with the volume cap above: a lead pushed to day+2 by volume still gets its
      // exact send time within that day picked by peak-time, if both are active. Voice is
      // excluded — there's no headless dispatcher yet that can place a deferred call later
      // (api/cron/dispatch-scheduled.ts only knows how to send WhatsApp/email), so a queued
      // voice call would just sit stuck forever. Voice always dials immediately for now.
      if ((usePeakScheduling && channelMode !== 'voice') || needsVolumeDefer) {
        const notBefore = needsVolumeDefer ? new Date(Date.now() + volumeDayOffset * 24 * 60 * 60 * 1000) : new Date();
        const scheduleFor = usePeakScheduling ? computeNextPeakSendTime(lead.country, notBefore) : notBefore;
        if (scheduleFor.getTime() - Date.now() > 60000) {
          const queuedLead: Lead = {
            ...lead,
            status: 'In Progress',
            whatsAppStatus: channelMode === 'omnichannel' || channelMode === 'whatsapp' ? 'Queued' : lead.whatsAppStatus,
            emailStatus: channelMode === 'omnichannel' || channelMode === 'email' ? 'Queued' : lead.emailStatus,
            whatsAppMessage: personalized.whatsApp,
            emailSubject: personalized.emailSubject,
            emailBody: personalized.emailBody,
            scheduledFor: scheduleFor.toISOString(),
          };
          onUpdateLead(queuedLead);

          const recipientId = recipientIdByClientRef.current[lead.id];
          if (recipientId && isSupabaseBrowserConfigured && supabase) {
            await supabase
              .from('campaign_recipients')
              .update({
                whatsapp_status: queuedLead.whatsAppStatus,
                email_status: queuedLead.emailStatus,
                scheduled_for: scheduleFor.toISOString(),
                payload: {
                  whatsappMessage: personalized.whatsApp,
                  templateParams,
                  emailSubject: personalized.emailSubject,
                  emailBody: personalized.emailBody,
                  senderName: campaignSettings.senderName,
                  senderEmail: resolvedSenderEmail,
                },
                updated_at: new Date().toISOString(),
              })
              .eq('id', recipientId);
          }

          setIsProcessingStep(false);
          if (isRunningRef.current && !isPausedRef.current) {
            timeoutId = setTimeout(() => {
              setCurrentIndex((prev) => prev + 1);
            }, 300);
          }
          return;
        }
      }

      // 2. Dispatch according to channel mode
      const nowFormatted = new Date().toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      let updatedLead: Lead = {
        ...lead,
        status: 'Contacted',
        lastContacted: nowFormatted,
        channelUsed: channelMode,
        whatsAppMessage: personalized.whatsApp,
        emailSubject: personalized.emailSubject,
        emailBody: personalized.emailBody,
      };

      const newLogs: OutreachDispatchLog[] = [];
      let sentWhatsAppMessageId: string | null = null;

      // WhatsApp dispatch
      if (channelMode === 'omnichannel' || channelMode === 'whatsapp') {
        if (lead.isValidPhone && lead.phone) {
          const waLink = generateWhatsAppLink(lead.phone, personalized.whatsApp);

          if (autoOpenApps && typeof window !== 'undefined') {
            window.open(waLink, '_blank');
          }

          // Trigger backend relay (useTemplate/templateParams computed above)
          let waDeliveryStatus = 'delivered';
          let waErrorDetail = '';
          try {
            const waRes = await fetch('/api/outreach/send-whatsapp', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
              },
              body: JSON.stringify({
                lead,
                messageText: personalized.whatsApp,
                channelSettings,
                webhookUrl: channelSettings.n8nWebhookUrl,
                templateParams,
                campaignRecipientId: recipientIdByClientRef.current[lead.id] || null,
              }),
            });
            const waData = await waRes.json();
            if (!waData.delivered) {
              waDeliveryStatus = 'failed';
              waErrorDetail = waData.errorDetail || 'Provider dispatch failed';
              updatedLead.whatsAppStatus = 'Failed';
            } else {
              // Meta (and Twilio) only confirm the message was ACCEPTED here — actual
              // delivery to the recipient's phone is reported later via an async status
              // webhook (see lib/whatsappWebhookHandler.ts), which flips this to Delivered/
              // Read/Failed once it arrives. Marking it "Delivered" immediately was
              // misleading: it showed as delivered even when Meta never actually got it
              // to the device (e.g. held for quality review, or the number never opened it).
              updatedLead.whatsAppStatus = 'Sent';
              sentWhatsAppMessageId = (waData.providerResponse?.messageId as string | undefined) || null;
            }
          } catch (err: any) {
            waDeliveryStatus = 'failed';
            waErrorDetail = err?.message || 'Network error';
            updatedLead.whatsAppStatus = 'Failed';
          }

          newLogs.push({
            id: `log-wa-${Date.now()}`,
            leadId: lead.id,
            leadName: lead.name,
            recipient: lead.phone,
            channel: 'whatsapp',
            status: waDeliveryStatus as 'delivered' | 'failed',
            timestamp: nowFormatted,
            preview: personalized.whatsApp.substring(0, 80) + '...',
            directUrl: waLink,
            errorDetail: waErrorDetail,
          });
        } else {
          updatedLead.whatsAppStatus = 'Failed';
        }
      }

      // Email dispatch
      if (channelMode === 'omnichannel' || channelMode === 'email') {
        if (lead.isValidEmail && lead.email) {
          const mailLink = generateMailtoLink(
            lead.email,
            personalized.emailSubject,
            personalized.emailBody
          );
          updatedLead.emailStatus = 'Sent';

          if (autoOpenApps && channelMode === 'email' && typeof window !== 'undefined') {
            window.open(mailLink, '_blank');
          }

          // Trigger email relay (handles both Vercel client-direct and backend server;
          // resolvedSenderEmail computed above)
          let emDeliveryStatus = 'delivered';
          let emErrorDetail = '';
          try {
            const emRes = await sendEmailDirectOrBackend({
              lead,
              subject: personalized.emailSubject,
              body: personalized.emailBody,
              channelSettings,
              senderName: campaignSettings.senderName,
              senderEmail: resolvedSenderEmail,
              accessToken,
              campaignRecipientId: recipientIdByClientRef.current[lead.id] || null,
            });
            if (!emRes.delivered) {
              emDeliveryStatus = 'failed';
              emErrorDetail = emRes.errorDetail || 'Provider dispatch failed';
              updatedLead.emailStatus = 'Failed';
            } else {
              updatedLead.emailStatus = 'Sent';
            }
          } catch (err: any) {
            emDeliveryStatus = 'failed';
            emErrorDetail = err?.message || 'Network error';
            updatedLead.emailStatus = 'Failed';
          }

          newLogs.push({
            id: `log-em-${Date.now()}`,
            leadId: lead.id,
            leadName: lead.name,
            recipient: lead.email,
            channel: 'email',
            status: emDeliveryStatus as 'delivered' | 'failed',
            timestamp: nowFormatted,
            subject: personalized.emailSubject,
            preview: personalized.emailBody.substring(0, 80) + '...',
            directUrl: mailLink,
            errorDetail: emErrorDetail,
          });
        } else {
          updatedLead.emailStatus = 'Failed';
        }
      }

      // Voice dispatch — places an outbound AI voice call via Vapi for each pending lead,
      // same trigger endpoint as the manual "Call via AI Voice Agent" button above.
      if (channelMode === 'voice') {
        if (lead.isValidPhone && lead.phone) {
          let callDeliveryStatus = 'delivered';
          let callErrorDetail = '';
          let placedCallId: string | null = null;
          try {
            const callRes = await fetch('/api/voice/vapi', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
              },
              body: JSON.stringify({ phone: lead.phone, name: lead.name, clientId: lead.id, country: lead.country, variables: { company: lead.company || '' } }),
            });
            const callData = await callRes.json().catch(() => ({}));
            if (callRes.ok && callData.ok) {
              updatedLead.voiceCallStatus = 'Sent';
              placedCallId = callData.callId || null;
            } else {
              callDeliveryStatus = 'failed';
              callErrorDetail = callData.error || 'Could not start the call.';
              updatedLead.voiceCallStatus = 'Failed';
            }
          } catch (err: any) {
            callDeliveryStatus = 'failed';
            callErrorDetail = err?.message || 'Network error';
            updatedLead.voiceCallStatus = 'Failed';
          }

          newLogs.push({
            id: `log-voice-${Date.now()}`,
            leadId: lead.id,
            leadName: lead.name,
            recipient: lead.phone,
            channel: 'voice',
            status: callDeliveryStatus as 'delivered' | 'failed',
            timestamp: nowFormatted,
            preview: placedCallId ? `AI Voice Agent call placed — call ID ${placedCallId}` : 'AI Voice Agent call placed',
            errorDetail: callErrorDetail,
          });
        } else {
          updatedLead.voiceCallStatus = 'Failed';
        }
      }

      onUpdateLead(updatedLead);
      if (newLogs.length > 0) {
        setDispatchLogs((prev) => [...newLogs, ...prev].slice(0, 50));
      }

      // Mirror the status onto the persisted campaign_recipients row, if this run is tracked.
      // Also persist the exact message content whenever something failed — the headless
      // retry dispatcher (api/cron/dispatch-scheduled.ts) has no browser/AI context of its
      // own, so it can only retry a failed send later using content saved here now.
      const recipientId = recipientIdByClientRef.current[lead.id];
      if (recipientId && isSupabaseBrowserConfigured && supabase) {
        const anyFailed = updatedLead.whatsAppStatus === 'Failed' || updatedLead.emailStatus === 'Failed';
        supabase
          .from('campaign_recipients')
          .update({
            whatsapp_status: updatedLead.whatsAppStatus,
            email_status: updatedLead.emailStatus,
            meeting_booked: updatedLead.status === 'Meeting Scheduled',
            error_detail: newLogs.find((l) => l.status === 'failed')?.errorDetail || null,
            ...(sentWhatsAppMessageId ? { whatsapp_message_id: sentWhatsAppMessageId } : {}),
            ...(anyFailed
              ? {
                  payload: {
                    whatsappMessage: personalized.whatsApp,
                    templateParams,
                    emailSubject: personalized.emailSubject,
                    emailBody: personalized.emailBody,
                    senderName: campaignSettings.senderName,
                    senderEmail: resolvedSenderEmail,
                  },
                }
              : {}),
            updated_at: new Date().toISOString(),
          })
          .eq('id', recipientId)
          .then(() => {});
      }

      setIsProcessingStep(false);

      // Wait for delay before next item
      if (isRunningRef.current && !isPausedRef.current) {
        timeoutId = setTimeout(() => {
          setCurrentIndex((prev) => prev + 1);
        }, delaySeconds * 1000);
      }
    };

    if (isRunning && !isPaused) {
      processNextLead();
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isRunning, isPaused, currentIndex]);

  const executeStart = async () => {
    whatsappVolumeIndexRef.current = todaysWhatsAppVolumeUsedRef.current;
    setShowBulkSendConfirm(false);
    if (useServerMessages) {
      await startMessageQueue();
      return;
    }
    // Create a persisted campaign + one campaign_recipients row per lead about to be
    // contacted, so progress is trackable on the Dashboard and in Analytics — not just
    // held in this component's in-memory run state.
    setPersistenceWarning(null);

    if (isSupabaseBrowserConfigured && !userId) {
      setPersistenceWarning(
        "You're not signed in, so this campaign will send but won't be saved to your Dashboard or Analytics. Sign in to track it."
      );
    } else if (isSupabaseBrowserConfigured && supabase && userId) {
      try {
        const toContact = leads.filter(
          (l) =>
            l.status === 'Pending' ||
            (channelMode === 'whatsapp' && l.whatsAppStatus === 'Pending') ||
            (channelMode === 'email' && l.emailStatus === 'Pending') ||
            (channelMode === 'voice' && (l.voiceCallStatus || 'Pending') === 'Pending') ||
            (channelMode === 'omnichannel' && (l.whatsAppStatus === 'Pending' || l.emailStatus === 'Pending'))
        );

        const { data: campaign, error: campaignError } = await supabase
          .from('campaigns')
          .insert({
            org_id: userId,
            name: `Campaign — ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`,
            objective: campaignSettings.customInstructions || null,
            channels: channelMode === 'omnichannel' ? ['whatsapp', 'email'] : [channelMode],
            ai_instructions: campaignSettings.customInstructions || null,
            status: 'running',
            template_name: selectedTemplate?.name || null,
          })
          .select('id')
          .single();

        if (campaignError || !campaign?.id) {
          console.error('Failed to create campaign row:', campaignError);
          setPersistenceWarning(
            `Couldn't save this campaign to your Dashboard (${campaignError?.message || 'unknown error'}) — it will still send, just won't appear in Analytics.`
          );
        } else if (toContact.length > 0) {
          currentCampaignIdRef.current = campaign.id;
          const { data: recipients, error: recipientsError } = await supabase
            .from('campaign_recipients')
            .insert(
              toContact.map((l) => ({
                campaign_id: campaign.id,
                org_id: userId,
                client_id: l.id,
              }))
            )
            .select('id, client_id');

          if (recipientsError) {
            console.error('Failed to create campaign_recipients rows:', recipientsError);
            setPersistenceWarning(
              `Campaign saved, but per-lead tracking failed (${recipientsError.message}) — sends will still work, just without per-lead status on the Dashboard.`
            );
          } else {
            recipientIdByClientRef.current = {};
            (recipients || []).forEach((r: { id: string; client_id: string }) => {
              recipientIdByClientRef.current[r.client_id] = r.id;
            });
          }
        }
      } catch (err: any) {
        console.error('Failed to persist campaign — continuing in local-only mode:', err);
        setPersistenceWarning(
          `Couldn't save this campaign to your Dashboard (${err?.message || 'unexpected error'}) — it will still send.`
        );
      }
    }

    setIsRunning(true);
    setIsPaused(false);
  };

  // Gate large/risky WhatsApp batches behind an explicit confirmation instead of silently
  // starting — either because it exceeds the safe daily limit (about to get auto-split
  // across days) or because it's a sizeable batch still in Free-form Text mode (which will
  // fail for anyone who hasn't messaged first — see ChannelConfigModal's Message Mode).
  const handleStart = async () => {
    if (channelMode === 'voice') {
      await startVoiceQueue();
      return;
    }
    const whatsappPendingCount = leads.filter(
      (l) =>
        (channelMode === 'omnichannel' || channelMode === 'whatsapp') &&
        l.whatsAppStatus === 'Pending' &&
        l.isValidPhone
    ).length;
    const safeDailyLimit = channelSettings.safeDailyWhatsAppLimit || 250;
    const isTemplateMode = channelSettings.whatsappMessageMode === 'template';
    const involvesWhatsApp = channelMode === 'omnichannel' || channelMode === 'whatsapp';

    // Cross-campaign: check how much of today's safe volume other campaigns (or an earlier
    // launch today) already used, so this decision reflects the whole day, not just this batch.
    const usedToday = involvesWhatsApp && userId ? await fetchTodaysWhatsAppVolumeUsed(userId) : 0;
    todaysWhatsAppVolumeUsedRef.current = usedToday;
    const remainingToday = Math.max(0, safeDailyLimit - usedToday);

    const exceedsDailyLimit = involvesWhatsApp && whatsappPendingCount > remainingToday;
    const looksLikeUnsafeColdBatch = involvesWhatsApp && whatsappPendingCount > 20 && !isTemplateMode;

    if (exceedsDailyLimit || looksLikeUnsafeColdBatch) {
      setBulkSendInfo({ count: whatsappPendingCount, safeDailyLimit, isTemplateMode, usedToday });
      setShowBulkSendConfirm(true);
      return;
    }
    executeStart();
  };

  const handlePause = () => {
    setIsPaused(true);
  };

  const handleResume = () => {
    setIsPaused(false);
  };

  const handleReset = () => {
    setIsRunning(false);
    setIsPaused(false);
    setCurrentIndex(0);
    setCurrentLead(null);
    setIsProcessingStep(false);
    setDispatchLogs([]);
  };

  const handleRestartAll = async () => {
    setIsRunning(false);
    setIsPaused(false);
    setCurrentIndex(0);
    setCurrentLead(null);
    setIsProcessingStep(false);
    // Re-fetch today's already-used volume (not just reset to 0) — otherwise a restart would
    // ignore whatever other campaigns already sent today and risk exceeding the real daily
    // cap, the same cross-campaign gap fixed in handleStart above.
    const involvesWhatsApp = channelMode === 'omnichannel' || channelMode === 'whatsapp';
    whatsappVolumeIndexRef.current = involvesWhatsApp && userId ? await fetchTodaysWhatsAppVolumeUsed(userId) : 0;
    if (onResetAllLeadsToPending) {
      onResetAllLeadsToPending();
    }
    setTimeout(() => {
      setIsRunning(true);
    }, 150);
  };

  const progressPercent = totalLeadsCount > 0
    ? Math.round(((totalLeadsCount - pendingLeads.length) / totalLeadsCount) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        description="Send personalised WhatsApp messages, emails or AI voice calls to your leads — the AI handles the replies."
        actions={
        <>
          {!isRunning && pendingLeads.length > 0 && pendingLeads.length < totalLeadsCount && (
            <button
              id="campaign-restart-icon-btn"
              onClick={handleRestartAll}
              className={headerSecondaryButton}
              title="Mark every lead as not contacted and send to all of them again"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Send to all again</span>
            </button>
          )}
          {leads.length > 0 && (
          <button id="campaign-reset-btn" onClick={handleReset} className={headerSecondaryButton} title="Clear this run's progress and activity log">
            <span>Reset</span>
          </button>
          )}

          {channelMode !== 'voice' && msgActive ? (
            <span className="text-xs text-ink-muted">
              {msgQueue?.campaign?.status === 'paused' ? 'Campaign paused' : 'Campaign sending'} — see below
            </span>
          ) : channelMode === 'voice' && queueActive ? (
            <span className="text-xs text-ink-muted">
              {callQueue?.campaign?.status === 'paused' ? 'Calls paused' : 'Calls running'} — see below
            </span>
          ) : !isRunning && leads.length === 0 ? (
            <button onClick={onOpenExcelUpload} className={headerPrimaryButton}>
              <Upload className="w-3.5 h-3.5" />
              <span>Import Leads</span>
            </button>
          ) : !isRunning ? (
            pendingLeads.length > 0 ? (
              <button
                id="campaign-start-btn"
                onClick={handleStart}
                disabled={leads.length === 0}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-full text-white bg-brand-strong hover:bg-[#0d6e62] shadow-sm transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play className="w-4 h-4 fill-white" />
                <span>Start campaign ({pendingLeads.length})</span>
              </button>
            ) : (
              <button
                id="campaign-restart-main-btn"
                onClick={handleRestartAll}
                disabled={leads.length === 0}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-full text-white bg-brand-strong hover:bg-[#0d6e62] shadow-sm transition-all active:scale-[0.98]"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Send to all again ({totalLeadsCount})</span>
              </button>
            )
          ) : isPaused ? (
            <button
              id="campaign-resume-btn"
              onClick={handleResume}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-full text-white bg-[#25D366] hover:bg-[#25D366] shadow-sm transition-all"
            >
              <Play className="w-4 h-4 fill-white" />
              <span>Resume</span>
            </button>
          ) : (
            <button
              id="campaign-pause-btn"
              onClick={handlePause}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-full text-ink bg-surface-hover hover:bg-border-strong border border-border-strong transition-all"
            >
              <Pause className="w-4 h-4" />
              <span>Pause</span>
            </button>
          )}
        </>
        }
      />

      {/* Only relevant when calling — otherwise it's a big card about a channel not in use. */}
      {channelMode === 'voice' && (
      <ErrorBoundary label="Live Voice Demo">
        <VoiceDemoWidget
          publicKey={channelSettings.vapiPublicKey}
          // An org's own public key goes with its own assistant; on ours, the org's assistant is in org_voice.
          assistantId={channelSettings.vapiPublicKey ? channelSettings.vapiAssistantId : orgVoice.voice?.assistantId || undefined}
        />
      </ErrorBoundary>
      )}

      <AnimatePresence>
        {persistenceWarning && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>{persistenceWarning}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Compact Settings Row */}
      <div className="bg-surface/50 backdrop-blur-3xl rounded-2xl border border-border p-5 shadow-card">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Channel Mode Selector */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
              Outreach Channel
            </label>
            <div className="grid grid-cols-4 gap-1 p-1 bg-surface-hover rounded-lg border border-border">
              <button
                id="mode-omnichannel"
                onClick={() => setChannelMode('omnichannel')}
                className={`py-1.5 px-1 rounded-md text-[10px] leading-tight font-medium transition-all flex items-center justify-center text-center ${
                  channelMode === 'omnichannel'
                    ? 'bg-surface text-ink shadow-xs font-semibold'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                WhatsApp &amp; Email
              </button>
              <button
                id="mode-whatsapp"
                onClick={() => setChannelMode('whatsapp')}
                className={`py-1.5 px-1 rounded-md text-[10px] leading-tight font-medium transition-all flex items-center justify-center text-center ${
                  channelMode === 'whatsapp'
                    ? 'bg-[#25D366] text-white shadow-xs font-semibold'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                WhatsApp
              </button>
              <button
                id="mode-email"
                onClick={() => setChannelMode('email')}
                className={`py-1.5 px-1 rounded-md text-[10px] leading-tight font-medium transition-all flex items-center justify-center text-center ${
                  channelMode === 'email'
                    ? 'bg-[#4285F4] text-white shadow-xs font-semibold'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                Email
              </button>
              <button
                id="mode-voice"
                onClick={() => setChannelMode('voice')}
                className={`py-1.5 px-1 rounded-md text-[10px] leading-tight font-medium transition-all flex items-center justify-center text-center gap-1 ${
                  channelMode === 'voice'
                    ? 'bg-gradient-to-r from-[#4285F4] to-[#128C7E] text-white shadow-xs font-semibold'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                <Phone className="w-3 h-3 shrink-0" />
                <span>Voice</span>
              </button>
            </div>
            <p className="text-[10px] text-ink-muted mt-1.5">
              {pendingLeads.length} of {totalLeadsCount} contact{totalLeadsCount === 1 ? '' : 's'} will be reached this run
            </p>
          </div>

          {/* Template Selector */}
          <div>
            {channelMode === 'voice' ? (
              <>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                  Voice Script
                </label>
                <div className="p-3 bg-canvas border border-border-strong rounded-lg text-[11px] text-ink-secondary leading-relaxed">
                  The agent follows the instructions and first message you set in Channel Setup → Voice — no template needed. Each lead's name and company are passed in automatically.
                </div>
              </>
            ) : (
              <>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                  Sequence Template
                </label>
                <select
                  id="campaign-template-select"
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-1.5 text-xs text-ink focus:ring-1 focus:ring-[#25D366] focus:border-[#25D366] font-medium"
                >
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
                <button
                  id="campaign-toggle-ai-copywriting"
                  type="button"
                  onClick={() =>
                    onUpdateSettings?.({
                      ...campaignSettings,
                      useAiCopywriting: !campaignSettings.useAiCopywriting,
                    })
                  }
                  className={`mt-1.5 w-full inline-flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-semibold border transition-colors ${
                    campaignSettings.useAiCopywriting
                      ? 'bg-[#128C7E]/10 border-[#128C7E]/30 text-emerald-300'
                      : 'bg-canvas border-border-strong text-ink-secondary'
                  }`}
                  title="When off, your template text is sent exactly as written (with {{variables}} filled in) — no AI rewrite."
                >
                  <Sparkles className="w-3 h-3" />
                  <span>{campaignSettings.useAiCopywriting ? 'AI Copywriting: On' : 'AI Copywriting: Off (send my text as-is)'}</span>
                </button>
                {useServerMessages && (
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <select
                      value={followupDays}
                      disabled={msgActive}
                      onChange={(e) => setFollowupDays(Number(e.target.value))}
                      className="w-full bg-canvas border border-border-strong rounded-lg px-2 py-1.5 text-[11px] text-ink disabled:opacity-50"
                      title="Leads who haven't replied get one follow-up — by email, and on WhatsApp too if a follow-up template is set in Channel Setup. Anyone who replies, books or opts out is skipped."
                    >
                      <option value={0}>No follow-up</option>
                      {[2, 3, 5, 7].map((d) => (
                        <option key={d} value={d}>
                          Follow up after {d} days
                        </option>
                      ))}
                    </select>
                    <select
                      value={followupTemplateId}
                      disabled={!followupDays || msgActive}
                      onChange={(e) => setFollowupTemplateId(e.target.value)}
                      className="w-full bg-canvas border border-border-strong rounded-lg px-2 py-1.5 text-[11px] text-ink disabled:opacity-50"
                      aria-label="Follow-up template"
                    >
                      {templates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Call pacing (voice) / send pacing (messages) */}
          {channelMode === 'voice' ? (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">Call pacing</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'Batch size', value: voiceBatchSize, set: setVoiceBatchSize, options: [[10, '10'], [30, '30'], [50, '50'], [100, '100'], [500, 'All']] },
                  { label: 'At once', value: voiceConcurrency, set: setVoiceConcurrency, options: [[1, '1'], [2, '2'], [3, '3'], [5, '5']] },
                  { label: 'Pause after batch', value: voiceBatchGap, set: setVoiceBatchGap, options: [[0, 'None'], [15, '15 min'], [30, '30 min'], [60, '1 hour'], [1440, 'Next day']] },
                ].map((ctl) => (
                  <label key={ctl.label} className="block">
                    <span className="block text-[10px] text-ink-muted mb-1">{ctl.label}</span>
                    <select
                      value={ctl.value}
                      disabled={queueActive}
                      onChange={(e) => ctl.set(Number(e.target.value))}
                      className="w-full bg-canvas border border-border-strong rounded-lg px-2 py-1.5 text-xs text-ink disabled:opacity-50"
                    >
                      {ctl.options.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-ink-muted mt-1">
                Calls run on our servers — you can close this page. Each lead is only called during their local business hours.
              </p>
            </div>
          ) : (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                Pacing Interval
              </label>
              <span className="text-xs font-semibold text-ink">{delaySeconds}s / contact</span>
            </div>
            <input
              id="campaign-delay-slider"
              type="range"
              min="1"
              max="10"
              step="0.5"
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(parseFloat(e.target.value))}
              className="w-full accent-[#25D366] cursor-pointer"
            />
            <p className="text-[10px] text-ink-muted mt-1">
              2–3s is safe for most WhatsApp numbers. Go slower for big batches on new numbers.
              {useServerMessages ? ' Sends run on our servers — you can close this page.' : ''}
            </p>
          </div>
          )}
        </div>
      </div>

      <AdvancedSection label="Advanced settings & diagnostics">
        {/* Country Peak-Time Scheduling Toggle */}
        <div className="flex items-center justify-between gap-3 p-3 bg-canvas rounded-xl border border-border">
          <div className="flex items-center gap-2.5">
            <Clock className="w-4 h-4 text-ink-muted shrink-0" />
            <div>
              <div className="text-xs font-semibold text-ink">Country Peak-Time Scheduling</div>
              <div className="text-[11px] text-ink-muted">
                {channelMode === 'voice'
                  ? 'Not available for Voice Agent calls yet — calls always dial immediately.'
                  : usePeakScheduling
                    ? "Messages send during each client's local business hours (needs a Country column on the lead)."
                    : 'Off — every message sends immediately regardless of the client\'s country.'}
              </div>
            </div>
          </div>
          <label className={`relative inline-flex items-center shrink-0 ${channelMode === 'voice' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={usePeakScheduling && channelMode !== 'voice'}
              disabled={channelMode === 'voice'}
              onChange={(e) => setUsePeakScheduling(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-border-strong peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-surface after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#128C7E]"></div>
          </label>
        </div>

        {/* Live Channel Status & Automation Diagnostics */}
        {channelMode !== 'voice' && (
        <div className="p-3 bg-canvas rounded-xl border border-border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-ink-muted">WhatsApp:</span>
              {isWhatsAppApiReady(channelSettings) ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                  {channelSettings.whatsAppProvider === 'twilio'
                    ? 'Twilio API'
                    : channelSettings.whatsAppProvider === 'cloud_api'
                      ? 'WhatsApp Cloud API'
                      : 'Custom Webhook'}{' '}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted bg-surface-hover px-2 py-0.5 rounded-md">
                  Manual (opens WhatsApp)
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-ink-muted">Email:</span>
              {isEmailApiReady(channelSettings) ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-md border border-blue-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
                  {channelSettings.emailProvider === 'resend'
                    ? 'Resend API'
                    : channelSettings.emailProvider === 'gmail'
                      ? 'Gmail'
                      : channelSettings.emailProvider === 'outlook'
                        ? 'Outlook'
                        : channelSettings.emailProvider === 'sendgrid'
                      ? 'SendGrid API'
                      : channelSettings.emailProvider === 'mailgun'
                        ? 'Mailgun API'
                        : 'SMTP'}{' '}
                  (Direct Inbox)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted bg-surface-hover px-2 py-0.5 rounded-md">
                  Manual (not connected)
                </span>
              )}
            </div>
          </div>

          {((channelMode !== 'whatsapp' && !isEmailApiReady(channelSettings)) ||
            (channelMode !== 'email' && !isWhatsAppApiReady(channelSettings))) && (
            <button
              onClick={onOpenChannelConfig}
              className="text-[11px] font-semibold text-[#128C7E] hover:underline flex items-center gap-1 shrink-0"
            >
              <Settings className="w-3 h-3" />
              <span>Connect API for 100% Background Sending →</span>
            </button>
          )}
        </div>
        )}

        {/* Resend Testing & Inbox Delivery Guidance Banner */}
        {channelMode !== 'voice' && channelSettings.emailProvider === 'resend' && (
          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-amber-200">
                📬 Why emails might not appear in Primary Inbox immediately:
              </p>
              <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-300">
                <li>
                  <strong>Check Gmail Spam & Promotions:</strong> Emails sent using the default free sandbox sender (<code className="bg-amber-500/15 px-1 rounded font-mono text-[10px]">onboarding@resend.dev</code>) often land in your <strong>Spam / Junk</strong> folder or <strong>Promotions</strong> tab.
                </li>
                <li>
                  <strong>Resend Free Sandbox Limitation:</strong> Without a custom verified domain on Resend.com, Resend <span className="underline">only allows delivering emails to the email address that owns your Resend account</span>. Attempts to send to other prospect addresses are blocked by Resend until your domain DNS is verified (Resend dashboard → Domains).
                </li>
              </ul>
            </div>
          </div>
        )}
      </AdvancedSection>

      {/* Campaign Finished Notification Banner */}
      <AnimatePresence>
        {!isRunning && pendingLeads.length === 0 && totalLeadsCount > 0 && (
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className={`p-4 rounded-xl border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
              failedForChannelCount > 0
                ? 'bg-amber-500/10 border-amber-500/30'
                : 'bg-gradient-to-r from-[#128C7E]/10 to-sky-500/10 border-[#128C7E]/30'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-8 h-8 rounded-full text-white flex items-center justify-center font-bold text-sm shrink-0 ${failedForChannelCount > 0 ? 'bg-amber-500' : 'bg-[#25D366]'}`}>
                {failedForChannelCount > 0 ? '!' : '✓'}
              </div>
              <div>
                <div className={`text-xs font-bold ${failedForChannelCount > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {failedForChannelCount > 0
                    ? `Campaign Cycle Finished — ${engagedCount} of ${totalLeadsCount} Succeeded, ${failedForChannelCount} Failed`
                    : `Campaign Cycle Complete (${totalLeadsCount} of ${totalLeadsCount} Leads Engaged)`}
                </div>
                <div className={`text-[11px] ${failedForChannelCount > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {failedForChannelCount > 0
                    ? `${failedForChannelCount} contact${failedForChannelCount === 1 ? '' : 's'} could not be reached via ${channelModeLabel} — see Activitypatch Activity below for the reason. You can retry after fixing the issue.`
                    : "All contacts in your spreadsheet have been processed. You can start the automated sequence again or send another follow-up round anytime."}
                </div>
              </div>
            </div>
            <button
              id="campaign-restart-banner-btn"
              onClick={handleRestartAll}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg text-white bg-[#128C7E] hover:bg-[#0E6D62] shadow-sm transition-all whitespace-nowrap active:scale-[0.98]"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Send to all again</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {channelMode !== 'voice' && (msgNote || msgQueue?.campaign) && (
        <div className="bg-surface/50 backdrop-blur-3xl rounded-2xl border border-border p-5 shadow-card space-y-3">
          {msgNote && <p className={`text-xs ${msgNote.ok ? 'text-emerald-300' : 'text-rose-400'}`}>{msgNote.text}</p>}
          {msgQueue?.campaign && (() => {
            const status = msgQueue.campaign.status;
            const line = (label: string, c: Record<string, number>) => {
              const sent = (c.Sent || 0) + (c.Delivered || 0) + (c.Read || 0);
              const waiting = (c.Queued || 0) + (c.Sending || 0);
              return `${label}: ${sent} sent · ${waiting} waiting${c.Failed ? ` · ${c.Failed} failed` : ''}${c.Skipped ? ` · ${c.Skipped} skipped` : ''}`;
            };
            const tallies = msgQueue.campaign.channels.map((ch) => (ch === 'whatsapp' ? msgQueue.whatsapp : msgQueue.email));
            const total =
              tallies.reduce((n, c) => n + Object.entries(c).reduce((m, [k, v]) => (k === 'Pending' ? m : m + Number(v)), 0), 0) || 1;
            const waiting = tallies.reduce((n, c) => n + (c.Queued || 0) + (c.Sending || 0), 0);
            return (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">
                      {status === 'completed'
                        ? 'Campaign finished'
                        : status === 'cancelled'
                          ? 'Campaign cancelled'
                          : status === 'paused'
                            ? 'Campaign paused'
                            : (msgQueue.initialWaiting ?? 0) > 0
                              ? 'Campaign sending'
                              : 'First messages sent — follow-ups scheduled'}
                    </p>
                    {msgQueue.campaign.channels.map((ch) => (
                      <p key={ch} className="text-[11px] text-ink-muted mt-0.5">
                        {line(ch === 'whatsapp' ? 'WhatsApp' : 'Email', ch === 'whatsapp' ? msgQueue.whatsapp : msgQueue.email)}
                      </p>
                    ))}
                    {msgQueue.campaign.followupDays && (
                      <p className="text-[11px] text-ink-muted mt-0.5">
                        Follow-ups after {msgQueue.campaign.followupDays} days: {msgQueue.followups.Queued || 0} scheduled ·{' '}
                        {msgQueue.followups.Sent || 0} sent · {msgQueue.followups.Skipped || 0} skipped (they replied or opted out)
                        {msgQueue.nextFollowupAt
                          ? ` · next ${new Date(msgQueue.nextFollowupAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
                          : ''}
                      </p>
                    )}
                    {status === 'running' && msgQueue.nextScheduledAt && (
                      <p className="text-[11px] text-ink-muted mt-0.5">
                        Some are scheduled for later (daily limit or best local time) — next at{' '}
                        {new Date(msgQueue.nextScheduledAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                      </p>
                    )}
                  </div>
                  {(status === 'running' || status === 'paused') && (
                    <div className="flex gap-2">
                      <button onClick={() => controlMessageQueue(status === 'paused' ? 'resume' : 'pause')} disabled={msgBusy} className={headerSecondaryButton}>
                        {status === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                        <span>{status === 'paused' ? 'Resume' : 'Pause'}</span>
                      </button>
                      <button onClick={() => controlMessageQueue('cancel')} disabled={msgBusy} className={headerSecondaryButton}>
                        <span>Cancel</span>
                      </button>
                    </div>
                  )}
                </div>
                <div className="w-full bg-border-strong rounded-full h-2 overflow-hidden">
                  <div className="bg-[#128C7E] h-2 rounded-full transition-all" style={{ width: `${Math.round(((total - waiting) / total) * 100)}%` }} />
                </div>
              </>
            );
          })()}
        </div>
      )}

      {channelMode === 'voice' && (queueNote || callQueue?.campaign) && (
        <div className="bg-surface/50 backdrop-blur-3xl rounded-2xl border border-border p-5 shadow-card space-y-3">
          {queueNote && (
            <p className={`text-xs ${queueNote.ok ? 'text-emerald-300' : 'text-rose-400'}`}>{queueNote.text}</p>
          )}
          {callQueue?.campaign && (() => {
            const c = callQueue.counts;
            const total = callQueue.campaign.total || 1;
            const finished = (c.done || 0) + (c.failed || 0) + (c.skipped || 0) + (c.cancelled || 0);
            const status = callQueue.campaign.status;
            return (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">
                      {status === 'done'
                        ? 'Call campaign finished'
                        : status === 'cancelled'
                          ? 'Call campaign cancelled'
                          : status === 'paused'
                            ? 'Call campaign paused'
                            : 'Call campaign running'}
                    </p>
                    <p className="text-[11px] text-ink-muted mt-0.5">
                      {callQueue.currentBatch && callQueue.totalBatches > 1 ? `Batch ${callQueue.currentBatch} of ${callQueue.totalBatches} · ` : ''}
                      {callQueue.callingNow} calling now · {c.queued || 0} waiting · {c.done || 0} called
                      {c.failed ? ` · ${c.failed} couldn't start` : ''}
                      {c.skipped ? ` · ${c.skipped} skipped` : ''}
                    </p>
                    {status === 'running' && callQueue.nextStartAt && (
                      <p className="text-[11px] text-ink-muted mt-0.5">
                        Next calls start {new Date(callQueue.nextStartAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                        {callQueue.waitingForHours ? ` · ${callQueue.waitingForHours} waiting for the lead's business hours` : ''}
                      </p>
                    )}
                  </div>
                  {(status === 'running' || status === 'paused') && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => controlVoiceQueue(status === 'paused' ? 'resume' : 'pause')}
                        disabled={queueBusy}
                        className={headerSecondaryButton}
                      >
                        {status === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                        <span>{status === 'paused' ? 'Resume' : 'Pause'}</span>
                      </button>
                      <button onClick={() => controlVoiceQueue('cancel')} disabled={queueBusy} className={headerSecondaryButton}>
                        <span>Cancel</span>
                      </button>
                    </div>
                  )}
                </div>
                <div className="w-full bg-border-strong rounded-full h-2 overflow-hidden">
                  <div className="bg-[#128C7E] h-2 rounded-full transition-all" style={{ width: `${Math.round((finished / total) * 100)}%` }} />
                </div>
                <p className="text-[10px] text-ink-muted">
                  {callQueue.campaign.batchSize >= total ? 'One batch' : `Batches of ${callQueue.campaign.batchSize}`} · {callQueue.campaign.concurrency} at once
                  {callQueue.campaign.batchGapMinutes ? ` · ${callQueue.campaign.batchGapMinutes >= 1440 ? 'next batch the next day' : `${callQueue.campaign.batchGapMinutes} min pause between batches`}` : ''}.
                  Unanswered calls are retried using your settings in Channel Setup → Voice.
                </p>
              </>
            );
          })()}
        </div>
      )}

      {/* Progress Bar & Status Line */}
      <div className="bg-surface/50 backdrop-blur-3xl rounded-2xl border border-border p-5 shadow-card">
        <div className="flex items-center justify-between text-xs text-ink-muted mb-1.5">
          <span className="font-medium">
            Campaign Progress: {totalLeadsCount - pendingLeads.length} of {totalLeadsCount} Leads Contacted
          </span>
          <span className="font-semibold text-ink">{progressPercent}%</span>
        </div>
        <div className="w-full bg-border-strong h-2.5 rounded-full overflow-hidden">
          <div
            className="bg-gradient-to-r from-[#128C7E] via-[#25D366] to-[#4285F4] h-full transition-all duration-300 rounded-full"
            style={{ width: `${progressPercent}%` }}
          ></div>
        </div>
      </div>

      {/* Main Campaign Activity Split View */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Live Active Lead & Message Personalization Stream */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-surface/50 backdrop-blur-3xl rounded-2xl border border-border p-5 shadow-card">
            <div className="flex items-center justify-between pb-4 border-b border-border">
              <div className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-[#25D366] animate-pulse' : 'bg-ink-muted'}`}></div>
                <h2 className="text-sm font-bold text-ink">
                  {isRunning ? 'Live Outreach Personalization Stream' : 'Message Preview'}
                </h2>
              </div>
              {isRunning && (
                <span className="text-[11px] font-semibold text-[#128C7E] bg-[#128C7E]/10 px-2 py-0.5 rounded-md border border-[#128C7E]/30">
                  {isProcessingStep ? (campaignSettings.useAiCopywriting ? 'Writing with AI…' : 'Preparing message…') : 'Sending…'}
                </span>
              )}
            </div>

            {currentLead ? (
              <div className="mt-4 space-y-4">
                {/* Active Lead Header */}
                <div className="p-3.5 bg-canvas rounded-xl border border-border flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-sm text-ink">{currentLead.name}</div>
                    <div className="text-xs text-ink-muted">
                      {currentLead.company} • {currentLead.phone} • {currentLead.email}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      onClick={() => handleCallLead(currentLead)}
                      disabled={isCalling || !currentLead.phone}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-[#4285F4] to-[#128C7E] text-white font-semibold text-[11px] shadow-sm hover:opacity-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isCalling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
                      <span>{isCalling ? 'Calling…' : 'Call via AI Voice Agent'}</span>
                    </button>
                    <button
                      onClick={() => onSelectLeadForSimulator(currentLead.id)}
                      className="text-xs font-medium text-[#128C7E] hover:underline flex items-center gap-1"
                    >
                      <span>View in Simulator</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {callResult && (
                  <p className={`text-[11px] -mt-2 ${callResult.ok ? 'text-emerald-300' : 'text-rose-400'}`}>{callResult.message}</p>
                )}

                {/* Voice Call Dispatch Status */}
                {channelMode === 'voice' && (
                  <div className="p-4 rounded-xl bg-gradient-to-r from-[#4285F4]/10 to-[#128C7E]/10 border border-[#128C7E]/20 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-r from-[#4285F4] to-[#128C7E] flex items-center justify-center text-white shrink-0 animate-pulse">
                      <Phone className="w-4 h-4" />
                    </div>
                    <p className="text-xs text-ink-secondary">
                      Placing an AI voice call to <strong className="text-ink">{currentLead.name}</strong> ({currentLead.phone}) via your Vapi assistant — status updates once the call connects or ends.
                    </p>
                  </div>
                )}

                {/* WhatsApp Message Preview Bubble */}
                {(channelMode === 'omnichannel' || channelMode === 'whatsapp') && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-[#128C7E] flex items-center gap-1.5">
                        <MessageSquare className="w-3.5 h-3.5 text-[#25D366]" />
                        WhatsApp Message Output ({currentLead.phone})
                      </span>
                      <a
                        href={generateWhatsAppLink(currentLead.phone, currentWhatsAppText)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] font-medium text-[#128C7E] hover:underline flex items-center gap-1"
                      >
                        <span>Open Chat</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <div className="p-3.5 bg-[#128C7E]/10 text-ink-secondary rounded-xl text-xs whitespace-pre-line border border-[#128C7E]/30 font-sans">
                      {currentWhatsAppText || 'Generating personalized WhatsApp hook...'}
                    </div>
                  </div>
                )}

                {/* Email Subject & Body Preview */}
                {(channelMode === 'omnichannel' || channelMode === 'email') && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-[#1967D2] flex items-center gap-1.5">
                        <Mail className="w-3.5 h-3.5 text-[#4285F4]" />
                        Email Draft ({currentLead.email})
                      </span>
                      <a
                        href={generateMailtoLink(
                          currentLead.email,
                          currentEmailSubject,
                          currentEmailBody
                        )}
                        className="text-[11px] font-medium text-[#1967D2] hover:underline flex items-center gap-1"
                      >
                        <span>Open Mail Client</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <div className="p-3.5 bg-[#4285F4]/10 text-ink-secondary rounded-xl text-xs space-y-2 border border-[#4285F4]/10">
                      <div className="font-semibold text-xs text-ink pb-1.5 border-b border-[#4285F4]/10">
                        Subject: {currentEmailSubject || 'Generating subject...'}
                      </div>
                      <div className="whitespace-pre-line text-xs font-sans text-ink-secondary">
                        {currentEmailBody || 'Generating personalized email body with Google Calendar booking link...'}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : previewLead && previewContent ? (
              <div className="mt-4 space-y-4">
                <div className="p-3.5 bg-canvas rounded-xl border border-border flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Next up</span>
                    <div className="font-semibold text-sm text-ink">{previewLead.name}</div>
                    <div className="text-xs text-ink-muted">
                      {previewLead.company} • {previewLead.phone} • {previewLead.email}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      onClick={() => handleCallLead(previewLead)}
                      disabled={isCalling || !previewLead.phone}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-[#4285F4] to-[#128C7E] text-white font-semibold text-[11px] shadow-sm hover:opacity-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isCalling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
                      <span>{isCalling ? 'Calling…' : 'Call via AI Voice Agent'}</span>
                    </button>
                    {onSelectLeadForSimulator && (
                      <button
                        onClick={() => onSelectLeadForSimulator(previewLead.id)}
                        className="text-xs font-medium text-[#128C7E] hover:underline flex items-center gap-1"
                      >
                        <span>View in Simulator</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {callResult && (
                  <p className={`text-[11px] -mt-2 ${callResult.ok ? 'text-emerald-300' : 'text-rose-400'}`}>{callResult.message}</p>
                )}

                {channelMode === 'voice' && (
                  <div className="p-4 rounded-xl bg-gradient-to-r from-[#4285F4]/10 to-[#128C7E]/10 border border-[#128C7E]/20 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-r from-[#4285F4] to-[#128C7E] flex items-center justify-center text-white shrink-0">
                      <Phone className="w-4 h-4" />
                    </div>
                    <p className="text-xs text-ink-secondary">
                      This contact will be called automatically by your AI Voice Agent when you launch this campaign — {pendingLeads.length} contact{pendingLeads.length === 1 ? '' : 's'} queued.
                    </p>
                  </div>
                )}

                {(channelMode === 'omnichannel' || channelMode === 'whatsapp') && (
                  <div className="space-y-1.5">
                    <span className="text-xs font-semibold text-[#128C7E] flex items-center gap-1.5">
                      <MessageSquare className="w-3.5 h-3.5 text-[#25D366]" />
                      WhatsApp Preview
                    </span>
                    <div className="p-3.5 bg-[#128C7E]/10 text-ink-secondary rounded-xl text-xs whitespace-pre-line border border-[#128C7E]/30 font-sans">
                      {previewContent.whatsApp}
                    </div>
                  </div>
                )}

                {(channelMode === 'omnichannel' || channelMode === 'email') && (
                  <div className="space-y-1.5">
                    <span className="text-xs font-semibold text-[#1967D2] flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5 text-[#4285F4]" />
                      Email Preview
                    </span>
                    <div className="p-3.5 bg-[#4285F4]/10 text-ink-secondary rounded-xl text-xs space-y-2 border border-[#4285F4]/10">
                      <div className="font-semibold text-xs text-ink pb-1.5 border-b border-[#4285F4]/10">
                        Subject: {previewContent.emailSubject}
                      </div>
                      <div className="whitespace-pre-line text-xs font-sans text-ink-secondary">{previewContent.emailBody}</div>
                    </div>
                  </div>
                )}

                {channelMode !== 'voice' && (
                  <p className="text-[11px] text-ink-muted italic">
                    {campaignSettings.useAiCopywriting
                      ? "Shown with your template as written — the AI will personalize this further for each contact once the campaign runs."
                      : `This is exactly what will send — ${pendingLeads.length} contact${pendingLeads.length === 1 ? '' : 's'} queued.`}
                  </p>
                )}
              </div>
            ) : (
              <div className="text-center py-12 px-4">
                {pendingLeads.length === 0 && totalLeadsCount > 0 ? (
                  <>
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 ${failedForChannelCount > 0 ? 'bg-amber-500/10 border border-amber-500/30 text-amber-300' : 'bg-[#128C7E]/10 border border-[#128C7E]/30 text-emerald-300'}`}>
                      {failedForChannelCount > 0 ? (
                        <AlertCircle className="w-6 h-6 text-amber-400" />
                      ) : (
                        <CheckCircle2 className="w-6 h-6 text-[#25D366]" />
                      )}
                    </div>
                    <h3 className="text-sm font-bold text-ink">{failedForChannelCount > 0 ? 'Campaign Finished — Some Failed' : 'Campaign Complete'}</h3>
                    <p className="text-xs text-ink-muted max-w-md mx-auto mt-1">
                      {failedForChannelCount > 0
                        ? `${engagedCount} of ${totalLeadsCount} contacts were successfully reached via ${channelModeLabel}; ${failedForChannelCount} failed — check Activity for the reason before retrying.`
                        : `All ${totalLeadsCount} contacts in your spreadsheet have been engaged via ${channelModeLabel}. Use "Send to all again" to run it again.`}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-full bg-canvas border border-border-strong flex items-center justify-center mx-auto text-ink-muted mb-3">
                      <Send className="w-5 h-5 text-ink-muted" />
                    </div>
                    <h3 className="text-sm font-semibold text-ink">{leads.length === 0 ? 'No leads yet' : 'Ready to start'}</h3>
                    <p className="text-xs text-ink-muted max-w-md mx-auto mt-1">
                      {leads.length === 0
                        ? 'Import your leads, then start the campaign.'
                        : channelMode === 'voice'
                          ? 'Click Start campaign and the AI calls each lead in turn.'
                          : 'Click Start campaign and each lead gets a personalised message.'}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Live Dispatch Feed & Audit Logs */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-surface/50 backdrop-blur-3xl rounded-2xl border border-border p-5 shadow-card">
            <div className="flex items-center justify-between pb-4 border-b border-border">
              <h2 className="text-sm font-bold text-ink flex items-center gap-2">
                <Clock className="w-4 h-4 text-ink-muted" />
                Activity
              </h2>
              <span className="text-xs text-ink-muted">{dispatchLogs.length} logs</span>
            </div>

            <div className="mt-3 divide-y divide-surface-hover max-h-[460px] overflow-y-auto no-scrollbar">
              {dispatchLogs.length > 0 ? (
                dispatchLogs.map((log) => (
                  <div key={log.id} className="py-2.5 text-xs">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5">
                        <div
                          className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                            log.channel === 'whatsapp'
                              ? 'bg-[#128C7E]/10 text-[#25D366]'
                              : log.channel === 'voice'
                                ? 'bg-gradient-to-r from-[#4285F4]/20 to-[#128C7E]/20 text-[#4285F4]'
                                : 'bg-[#4285F4]/10 text-[#4285F4]'
                          }`}
                        >
                          {log.channel === 'whatsapp' ? (
                            <MessageSquare className="w-3.5 h-3.5" />
                          ) : log.channel === 'voice' ? (
                            <Phone className="w-3.5 h-3.5" />
                          ) : (
                            <Mail className="w-3.5 h-3.5" />
                          )}
                        </div>
                        <div>
                          <div className="font-semibold text-ink flex items-center gap-1.5">
                            <span>{log.leadName}</span>
                            <span className="text-[10px] text-ink-muted font-normal">({log.recipient})</span>
                          </div>
                          <p className="text-[11px] text-ink-muted line-clamp-1 mt-0.5">
                            {log.preview}
                          </p>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        {log.status === 'delivered' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-300 bg-[#128C7E]/10 px-2 py-0.5 rounded-full">
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            Delivered
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
                            <AlertCircle className="w-2.5 h-2.5 text-amber-400" />
                            Failed
                          </span>
                        )}
                        <div className="text-[10px] text-ink-muted mt-0.5">{log.timestamp}</div>
                      </div>
                    </div>
                    {log.errorDetail && log.status === 'failed' && (
                      <div className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-md px-2 py-1 mt-1.5 ml-[34px]">
                        {log.errorDetail}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-xs text-ink-muted">
                  Nothing sent yet. Each message shows up here as it goes out.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showBulkSendConfirm && bulkSendInfo && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#18181B]/40 backdrop-blur-sm"
            onClick={() => setShowBulkSendConfirm(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="bg-surface/65 backdrop-blur-3xl border border-white/10 ring-1 ring-white/5 rounded-3xl max-w-md w-full shadow-modal overflow-hidden p-6 space-y-4"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-amber-500/15 flex items-center justify-center text-amber-400 shrink-0">
                  <AlertCircle className="w-4.5 h-4.5" />
                </div>
                <h3 className="font-bold text-sm text-ink">
                  Large WhatsApp batch — {bulkSendInfo.count} contacts
                </h3>
              </div>

              <div className="space-y-2.5 text-xs text-ink-secondary">
                {(() => {
                  const remainingToday = Math.max(0, bulkSendInfo.safeDailyLimit - bulkSendInfo.usedToday);
                  if (bulkSendInfo.count <= remainingToday) return null;
                  const overflow = bulkSendInfo.count - remainingToday;
                  const extraDays = Math.max(1, Math.ceil(overflow / bulkSendInfo.safeDailyLimit));
                  return (
                    <p>
                      Your safe daily limit is <strong>{bulkSendInfo.safeDailyLimit}</strong> (WhatsApp caps unique
                      conversations per 24h based on your number's messaging tier).
                      {bulkSendInfo.usedToday > 0 && (
                        <>
                          {' '}
                          You've already used <strong>{bulkSendInfo.usedToday}</strong> of that today (across other
                          campaigns), leaving <strong>{remainingToday}</strong> for right now.
                        </>
                      )}{' '}
                      We'll send {remainingToday > 0 ? `the first ${remainingToday}` : 'none'} now and automatically
                      schedule the rest across the next {extraDays} day{extraDays === 1 ? '' : 's'} — to protect your
                      number's quality rating instead of risking a ban.
                    </p>
                  );
                })()}
                {!bulkSendInfo.isTemplateMode && (
                  <p className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300">
                    You're in <strong>Free-form Text</strong> mode. Free-form messages only deliver to contacts who've
                    messaged you within the last 24h — most of a batch this size are likely first-time contacts, so
                    many of these will fail. Switch to <strong>Approved Template</strong> mode in Channel Setup for
                    reliable cold outreach.
                  </p>
                )}
                <p className="text-[11px] text-ink-muted">
                  Also make sure everyone in this list has actually opted in to receive messages from you — Meta can
                  suspend a number for unsolicited bulk messaging regardless of these safeguards.
                </p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowBulkSendConfirm(false)}
                  className="px-3.5 py-2 text-xs font-medium text-ink-muted hover:bg-surface-hover rounded-lg border border-border-strong"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={executeStart}
                  className="px-4 py-2 text-xs font-semibold rounded-lg text-white bg-brand-strong hover:bg-[#0d6e62] shadow-sm transition-all active:scale-[0.98]"
                >
                  I understand, start sending
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
