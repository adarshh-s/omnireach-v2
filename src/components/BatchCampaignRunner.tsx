import React, { useState, useEffect, useRef, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Play,
  Pause,
  RotateCcw,
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
  Zap,
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
import { DEFAULT_TEMPLATES } from '../data/sampleTemplates';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';
import { computeNextPeakSendTime } from '../../lib/countryTiming';
import { AdvancedSection } from './AdvancedSection';
import { VoiceDemoWidget } from './VoiceDemoWidget';

/**
 * Counts WhatsApp sends already used up today across every campaign for this org — not
 * just the one currently being launched. Without this, the safe-daily-limit safeguard only
 * protects a single campaign launch: two separate 200-lead campaigns run back to back would
 * each think they're under a 250 cap and both send in full, 400 total, silently over the
 * real limit. Counts anything already dispatched today (Sent/Delivered/Failed) plus anything
 * still Queued but scheduled to go out later today (from this or an earlier campaign) —
 * both consume today's budget.
 */
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
  const [dispatchLogs, setDispatchLogs] = useState<OutreachDispatchLog[]>([]);
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
        body: JSON.stringify({ phone: lead.phone, name: lead.name, variables: { company: lead.company || '' } }),
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
              body: JSON.stringify({ phone: lead.phone, name: lead.name, variables: { company: lead.company || '' } }),
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
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-ink tracking-tight">Batch Outreach</h1>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#25D366]/15 text-[#128C7E]">
              <Zap className="w-3 h-3 fill-[#25D366]" />
              Gemini 3.7 Flash AI Copywriter
            </span>
          </div>
          <p className="text-xs sm:text-sm text-ink-muted mt-1 max-w-2xl">
            Ingest contacts from Excel spreadsheets and automatically dispatch personalized WhatsApp messages, emails, or AI voice calls with Google Calendar booking links.
          </p>
        </div>

        {/* Primary Action */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            id="campaign-restart-icon-btn"
            onClick={handleRestartAll}
            className="p-2.5 rounded-full text-ink-muted hover:text-ink bg-surface/50 backdrop-blur-3xl hover:bg-surface-hover border border-border transition-colors"
            title="Start automation again (re-send to all leads)"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            id="campaign-reset-btn"
            onClick={handleReset}
            className="p-2.5 rounded-full text-ink-muted hover:text-ink bg-surface/50 backdrop-blur-3xl hover:bg-surface-hover border border-border transition-colors"
            title="Reset campaign state"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          {!isRunning ? (
            pendingLeads.length > 0 ? (
              <button
                id="campaign-start-btn"
                onClick={handleStart}
                disabled={leads.length === 0}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-full text-white bg-brand-strong hover:bg-[#0d6e62] shadow-sm transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play className="w-4 h-4 fill-white" />
                <span>Launch Campaign ({pendingLeads.length})</span>
              </button>
            ) : (
              <button
                id="campaign-restart-main-btn"
                onClick={handleRestartAll}
                disabled={leads.length === 0}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-full text-white bg-brand-strong hover:bg-[#0d6e62] shadow-sm transition-all active:scale-[0.98]"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Start Automation ({totalLeadsCount})</span>
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
        </div>
      </div>

      <VoiceDemoWidget publicKey={channelSettings.vapiPublicKey} assistantId={channelSettings.vapiAssistantId} />

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
                  The AI Voice Agent speaks from its own conversational script (configured in your Vapi assistant) — no template needed here. Each contact's company name is passed in automatically.
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
              </>
            )}
          </div>

          {/* Dispatch Interval Slider */}
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
              Sending too fast can get a WhatsApp Business number flagged by Meta — 2-3s is a safe pace for most
              accounts; slow it down further for large batches on newer numbers.
            </p>
          </div>
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
              <span className="text-[11px] font-semibold text-ink-muted">WhatsApp Dispatch:</span>
              {(channelSettings.whatsAppProvider === 'twilio' && channelSettings.twilioAccountSid && channelSettings.twilioAuthToken) ||
              (channelSettings.whatsAppProvider === 'cloud_api' && channelSettings.whatsappCloudApiKey && channelSettings.whatsappCloudPhoneId) ||
              (channelSettings.whatsAppProvider === 'webhook' && channelSettings.n8nWebhookUrl) ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                  {channelSettings.whatsAppProvider === 'twilio'
                    ? 'Twilio API'
                    : channelSettings.whatsAppProvider === 'cloud_api'
                      ? 'WhatsApp Cloud API'
                      : 'Custom Webhook'}{' '}
                  (Pure Background)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted bg-surface-hover px-2 py-0.5 rounded-md">
                  Web Direct Mode (Click-to-chat)
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-ink-muted">Email Dispatch:</span>
              {/* 'resend' needs no org-supplied key to count as configured — lib/emailSender.ts
                  falls back to the platform's own shared Resend account (RESEND_FROM_ADDRESS)
                  whenever the org hasn't set their own emailApiKey, so it's still a fully
                  automatic, zero-setup send path. This used to require emailApiKey here too,
                  which mislabeled that valid default as "Mailto Mode (No API key set)". */
              channelSettings.emailProvider === 'resend' ||
              ((channelSettings.emailProvider === 'sendgrid' || channelSettings.emailProvider === 'mailgun') && channelSettings.emailApiKey) ||
              (channelSettings.emailProvider === 'smtp' && channelSettings.smtpHost && channelSettings.smtpUser && channelSettings.smtpPass) ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-md border border-blue-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
                  {channelSettings.emailProvider === 'resend'
                    ? 'Resend API'
                    : channelSettings.emailProvider === 'sendgrid'
                      ? 'SendGrid API'
                      : channelSettings.emailProvider === 'mailgun'
                        ? 'Mailgun API'
                        : 'SMTP'}{' '}
                  (Direct Inbox)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted bg-surface-hover px-2 py-0.5 rounded-md">
                  Mailto Mode (No API key set)
                </span>
              )}
            </div>
          </div>

          {((channelMode !== 'whatsapp' &&
              !(
                ((channelSettings.emailProvider === 'resend' || channelSettings.emailProvider === 'sendgrid' || channelSettings.emailProvider === 'mailgun') && channelSettings.emailApiKey) ||
                (channelSettings.emailProvider === 'smtp' && channelSettings.smtpHost && channelSettings.smtpUser && channelSettings.smtpPass)
              )) ||
            (channelMode !== 'email' &&
              !(
                (channelSettings.whatsAppProvider === 'twilio' && channelSettings.twilioAccountSid && channelSettings.twilioAuthToken) ||
                (channelSettings.whatsAppProvider === 'cloud_api' && channelSettings.whatsappCloudApiKey && channelSettings.whatsappCloudPhoneId) ||
                (channelSettings.whatsAppProvider === 'webhook' && channelSettings.n8nWebhookUrl)
              ))) && (
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
                    ? `${failedForChannelCount} contact${failedForChannelCount === 1 ? '' : 's'} could not be reached via ${channelModeLabel} — see Live Dispatch Activity below for the reason. You can retry after fixing the issue.`
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
              <span>Start Automation One More Time</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

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
                  {isProcessingStep ? (campaignSettings.useAiCopywriting ? 'AI Formatting...' : 'Building Message...') : 'Dispatching...'}
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
                        ? `${engagedCount} of ${totalLeadsCount} contacts were successfully reached via ${channelModeLabel}; ${failedForChannelCount} failed — check Live Dispatch Activity for the reason before retrying.`
                        : `All ${totalLeadsCount} contacts in your spreadsheet have been engaged via ${channelModeLabel}. Use "Start Automation One More Time" above to run it again.`}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-full bg-canvas border border-border-strong flex items-center justify-center mx-auto text-ink-muted mb-3">
                      <Send className="w-5 h-5 text-ink-muted" />
                    </div>
                    <h3 className="text-sm font-semibold text-ink">Campaign Ready for Launch</h3>
                    <p className="text-xs text-ink-muted max-w-md mx-auto mt-1">
                      Import contacts and click "Launch Campaign" to automatically cycle through them{channelMode === 'voice' ? ' and place personalized AI voice calls' : ', generate personalized copy, and dispatch WhatsApp and Email messages'}.
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
                Live Dispatch Activity
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
                  No dispatches yet in this session. Start the campaign to see real-time delivery logs.
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
