import React, { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X,
  Settings,
  MessageSquare,
  Mail,
  Network,
  CheckCircle2,
  Send,
  Loader2,
  Calendar,
  ExternalLink,
  Phone,
  Slack,
  ShieldCheck,
  Trash2,
  Database,
  RefreshCw,
} from 'lucide-react';
import { ChannelApiSettings, CampaignSettings, CalendarSlot, ChannelSecretKey, DEFAULT_VOICE_FALLBACK_MESSAGE, Lead } from '../types';
import { sanitizePhoneNumber } from '../utils/excelParser';
import { sendEmailDirectOrBackend } from '../services/emailService';
import { sendWhatsAppDirectOrBackend } from '../services/whatsappService';
import { resolveTemplateVariables } from '../utils/outreachEngine';
import { useGoogleCalendarConnection } from '../hooks/useGoogleCalendarConnection';
import { useMicrosoftCalendarConnection } from '../hooks/useMicrosoftCalendarConnection';
import { useEmailOAuthConnection } from '../hooks/useEmailOAuthConnection';
import { useEmailDomain } from '../hooks/useEmailDomain';
import { useOrgVoice } from '../hooks/useOrgVoice';
import { VOICE_LANGUAGES, findVoiceLanguage } from '../../lib/voiceLanguages';
import { useChannelHealth } from '../hooks/useChannelHealth';
import {
  SetupSection,
  Card,
  Field,
  ChoiceCard,
  Segmented,
  Note,
  CopyRow,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './channelSetup/SetupUI';
import { AdvancedSection } from './AdvancedSection';
import { SecretInput } from './SecretInput';
import { hasChannelSecret } from '../utils/channelSecrets';

type SetupSectionId = 'whatsapp' | 'email' | 'voice' | 'calendar' | 'crm' | 'compliance' | 'notifications' | 'integrations';

interface ChannelConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: ChannelApiSettings;
  onSaveSettings: (settings: ChannelApiSettings) => void;
  campaignSettings?: CampaignSettings;
  availableSlots?: CalendarSlot[];
  userId?: string | null;
  accessToken?: string | null;
  /** Adds leads (deduplicated) — used by "Import from CRM". */
  onImportLeads?: (leads: Lead[]) => void;
}

export const ChannelConfigModal: React.FC<ChannelConfigModalProps> = ({
  isOpen,
  onClose,
  settings,
  campaignSettings,
  availableSlots = [],
  onSaveSettings,
  userId = null,
  accessToken = null,
  onImportLeads,
}) => {
  const [formData, setFormData] = useState<ChannelApiSettings>(settings);
  // This modal stays mounted from app start, before cloud settings have loaded — start each
  // opening from the current settings so a save never writes back a stale copy.
  useEffect(() => {
    if (!isOpen) return;
    setFormData(settings);
    // "Other" email = the org's own SMTP or API key; 'resend' without its own key is automatic.
    setEmailAdvancedOpen(
      ['smtp', 'sendgrid', 'mailgun', 'webhook'].includes(settings.emailProvider) ||
        (settings.emailProvider === 'resend' && !!settings.savedSecrets?.emailApiKey)
    );
    setWhatsappMoreOpen(settings.whatsAppProvider === 'twilio' || settings.whatsAppProvider === 'webhook');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const hasSecret = (key: ChannelSecretKey) => hasChannelSecret(formData, key);
  // null removes a saved secret: it's persisted as JSON null, which the database reads as
  // "delete" (divert_org_channel_secrets) — hence the cast past the string-typed field.
  const setSecret = (key: ChannelSecretKey, value: string | null) => {
    if (key === 'vapiApiKey') setVapiPromptLoaded(false);
    setFormData((prev) => ({
      ...prev,
      [key]: value as unknown as string,
      ...(value === null ? { savedSecrets: { ...prev.savedSecrets, [key]: false } } : {}),
    }));
  };
  const [activeSubTab, setActiveSubTab] = useState<SetupSectionId>('whatsapp');
  const [savedSuccess, setSavedSuccess] = useState(false);
  // 'resend' with no org-supplied API key is the automatic platform default (see the
  // "Email sending is automatic" banner) — only a provider that actually needs the org's
  // own credentials counts as "Advanced". Without excluding 'resend' here, every org opened
  // this panel already in Advanced mode by default (DEFAULT_CHANNEL_SETTINGS.emailProvider
  // is 'resend'), even though nothing had actually been configured.
  const [emailAdvancedOpen, setEmailAdvancedOpen] = useState(
    !!(settings.emailProvider && settings.emailProvider !== 'mailto_direct' && settings.emailProvider !== 'resend')
  );
  const [whatsappMoreOpen, setWhatsappMoreOpen] = useState(
    settings.whatsAppProvider === 'twilio' || settings.whatsAppProvider === 'webhook'
  );
  const googleCalendar = useGoogleCalendarConnection(userId, accessToken);
  const microsoftCalendar = useMicrosoftCalendarConnection(userId, accessToken);
  const emailOAuth = useEmailOAuthConnection(userId, accessToken);
  const emailDomain = useEmailDomain(accessToken, isOpen && activeSubTab === 'email');
  const orgVoice = useOrgVoice(userId, accessToken);
  // CRM connection (lib/crm/*) — loaded when its section opens.
  type CrmId = 'hubspot' | 'zoho' | 'salesforce';
  const CRM_NAMES: Record<CrmId, string> = { hubspot: 'HubSpot', zoho: 'Zoho CRM', salesforce: 'Salesforce' };
  const [crm, setCrm] = useState<{
    available: CrmId[];
    connection: { provider: CrmId; account: string | null; lastSyncAt: string | null; lastError: string | null } | null;
    pending: number;
    failed: number;
  } | null>(null);
  const [crmBusy, setCrmBusy] = useState<string | null>(null);
  const [crmNote, setCrmNote] = useState<{ ok: boolean; text: string } | null>(null);
  const loadCrm = async () => setCrm(await dncCall('crm'));
  useEffect(() => {
    if (isOpen && activeSubTab === 'crm') loadCrm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, activeSubTab]);
  const connectCrm = async (id: CrmId) => {
    if (!accessToken) return;
    setCrmBusy(id);
    setCrmNote(null);
    const res = await fetch(`/api/auth/google/connect?purpose=crm&crm=${id}`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.authUrl) {
      window.location.href = data.authUrl;
      return;
    }
    setCrmNote({ ok: false, text: data.error || 'Could not start the connection.' });
    setCrmBusy(null);
  };
  const importCrm = async () => {
    setCrmBusy('import');
    setCrmNote(null);
    const r = await dncCall('crm-import', { limit: 500 });
    setCrmBusy(null);
    if (!r?.ok) {
      setCrmNote({ ok: false, text: r?.error || 'Could not import.' });
      return;
    }
    const code = campaignSettings?.defaultCountryCode || '+91';
    const leads: Lead[] = (r.contacts || [])
      .filter((c: any) => c.phone || c.email)
      .map((c: any, i: number) => {
        const { formatted, isValid } = sanitizePhoneNumber(c.phone, code);
        return {
          id: `lead-crm-${Date.now()}-${i}`,
          name: c.name,
          company: c.company || '',
          phone: c.phone ? formatted || c.phone : '',
          rawPhone: c.phone || '',
          email: c.email || '',
          country: c.country || undefined,
          status: 'Pending',
          whatsAppStatus: 'Pending',
          emailStatus: 'Pending',
          isValidPhone: !!c.phone && isValid,
          isValidEmail: !!c.email && c.email.includes('@'),
        } as Lead;
      });
    onImportLeads?.(leads);
    setCrmNote({ ok: true, text: `Imported ${leads.length} from ${CRM_NAMES[r.provider as CrmId]} — anyone already in your leads was skipped.` });
  };

  // Do-not-contact list (lib/suppression.ts) — loaded when its section opens.
  const [dnc, setDnc] = useState<{ total: number; entries: { id: string; kind: string; value: string; reason: string | null }[] } | null>(null);
  const [dncInput, setDncInput] = useState('');
  const [dncBusy, setDncBusy] = useState(false);
  const [dncNote, setDncNote] = useState<string | null>(null);
  const dncCall = async (action: string, body?: Record<string, unknown>) => {
    if (!accessToken) return null;
    const res = await fetch(`/api/whatsapp/subscribe-app?action=${action}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res.json().catch(() => null);
  };
  const loadDnc = async () => setDnc(await dncCall('do-not-contact'));
  useEffect(() => {
    if (isOpen && activeSubTab === 'compliance') loadDnc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, activeSubTab]);
  const [domainInput, setDomainInput] = useState('');
  const [fromLocalPart, setFromLocalPart] = useState('outreach');
  const { health, loading: healthLoading, reload: reloadHealth } = useChannelHealth(accessToken);

  // Test email state
  const [testEmailTo, setTestEmailTo] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testResultMsg, setTestResultMsg] = useState('');

  // Test WhatsApp state
  const [testWaTo, setTestWaTo] = useState('');
  const [testWaStatus, setTestWaStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testWaResultMsg, setTestWaResultMsg] = useState('');


  // Test Slack notification state — posts directly to the webhook URL from the browser
  // (text/plain avoids a CORS preflight; Slack parses the JSON body regardless).
  const [testSlackStatus, setTestSlackStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testSlackResultMsg, setTestSlackResultMsg] = useState('');

  const handleTestSlack = async () => {
    if (!formData.slackWebhookUrl) {
      setTestSlackStatus('error');
      setTestSlackResultMsg('Paste a Slack Incoming Webhook URL first.');
      return;
    }
    setTestSlackStatus('sending');
    setTestSlackResultMsg('');
    try {
      const res = await fetch(formData.slackWebhookUrl.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ text: '👋 Test notification from OmniReach AI — Slack notifications are wired up correctly.' }),
      });
      if (res.ok) {
        setTestSlackStatus('success');
        setTestSlackResultMsg('Sent — check your Slack channel.');
      } else {
        setTestSlackStatus('error');
        setTestSlackResultMsg(`Slack rejected the request (${res.status}). Double-check the webhook URL.`);
      }
    } catch (err: any) {
      setTestSlackStatus('error');
      setTestSlackResultMsg(err?.message || 'Could not reach Slack — check the webhook URL.');
    }
  };

  // WABA app-subscription state — a required Meta step with no dashboard UI of its own,
  // without which inbound replies never reach the webhook.
  const [subscribeStatus, setSubscribeStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [subscribeMsg, setSubscribeMsg] = useState('');

  // The shared Verify Token value orgs paste into their own Meta App's webhook config —
  // fetched once (it's not sensitive, but does live server-side as an env var).
  const [verifyToken, setVerifyToken] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    if (activeSubTab !== 'whatsapp' || !accessToken || verifyToken !== null) return;
    fetch('/api/whatsapp/subscribe-app', { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((res) => res.json())
      .then((data) => setVerifyToken(data.verifyToken || ''))
      .catch(() => setVerifyToken(''));
  }, [activeSubTab, accessToken, verifyToken]);

  // AI Voice Agent (Vapi) — prompt/first-message editor synced live to the org's own
  // assistant, plus a one-time load of whatever's currently live on Vapi so the editor
  // doesn't start blank and risk overwriting an existing prompt.
  const [vapiPromptLoaded, setVapiPromptLoaded] = useState(false);
  const [isLoadingVapiPrompt, setIsLoadingVapiPrompt] = useState(false);
  const [isSyncingVapi, setIsSyncingVapi] = useState(false);
  const [vapiSyncResult, setVapiSyncResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (activeSubTab !== 'voice' || !accessToken || vapiPromptLoaded) return;
    // No assistant of this org's own yet (brand new, hasn't saved a prompt before) — nothing
    // to prefill; leave the fields empty for them to write a fresh prompt. On the platform's
    // Vapi account the assistant id lives server-side (org_voice), on their own in settings.
    if (!orgVoice.voice?.assistantId && !formData.vapiAssistantId) return;
    setVapiPromptLoaded(true);
    setIsLoadingVapiPrompt(true);
    fetch('/api/voice/vapi?action=get-assistant', { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok) {
          setFormData((prev) => ({
            ...prev,
            // Live Vapi copy first — it carries the AI Learning lessons block, which the
            // locally saved copy of the prompt goes stale on as lessons change.
            vapiSystemPrompt: data.systemPrompt || prev.vapiSystemPrompt || '',
            vapiFirstMessage: data.firstMessage || prev.vapiFirstMessage || '',
          }));
        }
      })
      .catch(() => {})
      .finally(() => setIsLoadingVapiPrompt(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubTab, accessToken, vapiPromptLoaded, formData.vapiAssistantId, orgVoice.voice?.assistantId]);

  const handleSyncVapiAssistant = async () => {
    if (!accessToken) return;
    setIsSyncingVapi(true);
    setVapiSyncResult(null);
    try {
      const res = await fetch('/api/voice/vapi?action=sync-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          systemPrompt: formData.vapiSystemPrompt || '',
          firstMessage: formData.vapiFirstMessage || '',
          language: formData.vapiLanguage || null,
          voiceGender: formData.vapiVoiceGender || 'female',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        // The server re-attaches the current AI Learning lessons block — show what's actually live.
        if (data.systemPrompt) setFormData((prev) => ({ ...prev, vapiSystemPrompt: data.systemPrompt }));
        // A newly created assistant on the org's own Vapi account is kept with its other Vapi
        // settings (so the next save doesn't drop it); one on ours is recorded server-side.
        if (data.assistantId && hasSecret('vapiApiKey')) setFormData((prev) => ({ ...prev, vapiAssistantId: data.assistantId }));
        if (data.assistantId) orgVoice.refresh();
        setVapiSyncResult({ ok: true, message: 'Synced — your Vapi assistant now uses this prompt live.' });
      } else {
        setVapiSyncResult({ ok: false, message: data.error || 'Could not sync to Vapi.' });
      }
    } catch (err: any) {
      setVapiSyncResult({ ok: false, message: err?.message || 'Failed to reach the server.' });
    } finally {
      setIsSyncingVapi(false);
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField((f) => (f === field ? null : f)), 1500);
    });
  };


  const handleSendTestWhatsApp = async () => {
    if (!testWaTo.trim()) {
      setTestWaStatus('error');
      setTestWaResultMsg('Enter a phone number (with country code) to send the test to first');
      return;
    }
    if (formData.whatsAppProvider === 'twilio' && (!formData.twilioAccountSid || !hasSecret('twilioAuthToken'))) {
      setTestWaStatus('error');
      setTestWaResultMsg('Please enter your Twilio Account SID and Auth Token first');
      return;
    }
    if (formData.whatsAppProvider === 'cloud_api' && (!hasSecret('whatsappCloudApiKey') || !formData.whatsappCloudPhoneId)) {
      setTestWaStatus('error');
      setTestWaResultMsg('Please enter your WhatsApp Cloud API access token and Phone Number ID first');
      return;
    }
    if (formData.whatsAppProvider === 'webhook' && !formData.n8nWebhookUrl) {
      setTestWaStatus('error');
      setTestWaResultMsg('Please set a webhook URL under n8n / Webhook first');
      return;
    }
    const useTemplate = formData.whatsappMessageMode === 'template';
    if (useTemplate && formData.whatsAppProvider === 'twilio' && !formData.twilioContentSid) {
      setTestWaStatus('error');
      setTestWaResultMsg('Please enter your Twilio Content SID first');
      return;
    }
    if (useTemplate && formData.whatsAppProvider === 'cloud_api' && !formData.whatsappTemplateName) {
      setTestWaStatus('error');
      setTestWaResultMsg('Please enter your approved template name first');
      return;
    }
    setTestWaStatus('sending');
    setTestWaResultMsg('');
    try {
      const sampleLead = { id: 'test-lead', name: 'Jane Doe', company: 'Sample Company LLC', phone: testWaTo, email: 'jane.doe@example.com' };
      const fallbackSettings: CampaignSettings = campaignSettings || {
        channelMode: 'whatsapp',
        selectedTemplateId: '',
        delayBetweenMessagesSeconds: 2,
        autoAdvance: false,
        companyName: '',
        senderName: '',
        senderEmail: '',
        senderPhone: '',
        serviceDescription: '',
        defaultCountryCode: '+971',
        includeBookingLink: true,
      };
      const templateParams = useTemplate
        ? resolveTemplateVariables(
            (formData.whatsAppProvider === 'twilio' ? formData.twilioContentVariables : formData.whatsappTemplateVariables) || [],
            sampleLead as any,
            fallbackSettings,
            availableSlots
          )
        : undefined;

      const data = await sendWhatsAppDirectOrBackend({
        lead: sampleLead,
        messageText: 'Hello! This is a live test from your OmniReach AI outreach system — your WhatsApp connection is active. 🎉',
        channelSettings: formData,
        templateParams,
        accessToken,
      });

      if (data.delivered) {
        setTestWaStatus('success');
        setTestWaResultMsg(
          formData.whatsAppProvider === 'cloud_api'
            ? `Message accepted by Meta for ${testWaTo}. Check the phone — if nothing arrives in a minute, see the troubleshooting notes above (test-recipient verification, token expiry, quality hold).`
            : `WhatsApp message sent to ${testWaTo}! Check the phone.`
        );
      } else {
        setTestWaStatus('error');
        setTestWaResultMsg(data.errorDetail || 'Failed to deliver WhatsApp message. Please check your credentials.');
      }
    } catch (err: any) {
      setTestWaStatus('error');
      setTestWaResultMsg(err.message || 'Connection failed');
    }
  };

  const handleSubscribeApp = async () => {
    if (!hasSecret('whatsappCloudApiKey') || !formData.whatsappBusinessAccountId) {
      setSubscribeStatus('error');
      setSubscribeMsg('Enter your Access Token and WhatsApp Business Account ID above first.');
      return;
    }
    if (!accessToken) {
      setSubscribeStatus('error');
      setSubscribeMsg('Sign in required.');
      return;
    }
    setSubscribeStatus('loading');
    setSubscribeMsg('');
    try {
      const res = await fetch('/api/whatsapp/subscribe-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        // A saved token isn't in the browser — the server falls back to the saved one.
        body: JSON.stringify({
          accessToken: formData.whatsappCloudApiKey || undefined,
          wabaId: formData.whatsappBusinessAccountId,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSubscribeStatus('success');
        setSubscribeMsg('Subscribed! Replies to this number will now reach your AI booking bot.');
      } else {
        setSubscribeStatus('error');
        setSubscribeMsg(data.error || 'Subscription failed.');
      }
    } catch (err: any) {
      setSubscribeStatus('error');
      setSubscribeMsg(err.message || 'Connection failed.');
    }
  };

  type TemplateVarKey =
    | 'whatsappTemplateVariables'
    | 'twilioContentVariables'
    | 'whatsappFollowupTemplateVariables'
    | 'twilioFollowupContentVariables';

  const addTemplateVariable = (key: TemplateVarKey) => {
    setFormData({ ...formData, [key]: [...(formData[key] || []), ''] });
  };
  const updateTemplateVariable = (key: TemplateVarKey, idx: number, value: string) => {
    const arr = [...(formData[key] || [])];
    arr[idx] = value;
    setFormData({ ...formData, [key]: arr });
  };
  const removeTemplateVariable = (key: TemplateVarKey, idx: number) => {
    const arr = [...(formData[key] || [])];
    arr.splice(idx, 1);
    setFormData({ ...formData, [key]: arr });
  };

  const renderTemplateVariableEditor = (key: TemplateVarKey) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-[11px] font-semibold text-ink-muted">
          Body Variables (in order — fill {'{{1}}'}, {'{{2}}'}, ... in your approved template)
        </label>
        <button
          type="button"
          onClick={() => addTemplateVariable(key)}
          className="text-[10px] font-semibold text-[#128C7E] hover:underline"
        >
          + Add Variable
        </button>
      </div>
      {(formData[key] || []).length === 0 ? (
        <p className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1.5">
          ⚠️ 0 variables configured. If your approved template has any {'{{n}}'} placeholders in its body, you must add one row per placeholder here — otherwise Meta will reject the send with "number of parameters does not match" (error 132000).
        </p>
      ) : (
        <p className="text-[10px] text-ink-muted">
          {(formData[key] || []).length} variable{(formData[key] || []).length === 1 ? '' : 's'} configured — must exactly match the number of {'{{n}}'} placeholders in your approved template's body. Type a <strong>plain value</strong> (e.g. <code className="bg-surface-hover px-1 rounded">TEST-001</code>) or a single token (e.g. <code className="bg-surface-hover px-1 rounded">{'{{name}}'}</code>) — no quotes, no extra braces around your answer.
        </p>
      )}
      {(formData[key] || []).map((val, idx) => (
        <div key={idx} className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold text-ink-muted w-14 shrink-0">Slot #{idx + 1}</span>
          <input
            type="text"
            placeholder="e.g. TEST-001 or {{name}} — no quotes/braces around the whole value"
            value={val}
            onChange={(e) => updateTemplateVariable(key, idx, e.target.value)}
            className="flex-1 bg-surface border border-border-strong rounded-lg px-2.5 py-1 text-xs font-mono"
          />
          <button
            type="button"
            onClick={() => removeTemplateVariable(key, idx)}
            className="p-1 text-ink-muted hover:text-red-400"
            title="Remove"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );

  const handleSendTestEmail = async () => {
    if (!testEmailTo.trim()) {
      setTestStatus('error');
      setTestResultMsg('Enter an email address to send the test to first');
      return;
    }
    if (formData.emailProvider === 'gmail' || formData.emailProvider === 'outlook') {
      if (!emailOAuth.status.connected || emailOAuth.status.provider !== formData.emailProvider) {
        setTestStatus('error');
        setTestResultMsg(`Connect ${formData.emailProvider === 'gmail' ? 'Gmail' : 'Outlook'} first`);
        return;
      }
    } else if (formData.emailProvider === 'smtp') {
      if (!formData.smtpHost || !formData.smtpUser || !hasSecret('smtpPass')) {
        setTestStatus('error');
        setTestResultMsg('Please enter SMTP host, username, and password first');
        return;
      }
    } else if (formData.emailProvider === 'mailgun') {
      if (!hasSecret('emailApiKey') || !formData.mailgunDomain) {
        setTestStatus('error');
        setTestResultMsg('Please enter your Mailgun API key and domain first');
        return;
      }
    } else if (formData.emailProvider !== 'resend' && !hasSecret('emailApiKey')) {
      setTestStatus('error');
      setTestResultMsg('Please enter an API Key first');
      return;
    }
    setTestStatus('sending');
    setTestResultMsg('');
    try {
      const data = await sendEmailDirectOrBackend({
        lead: {
          id: 'test-lead',
          name: 'there',
          email: testEmailTo,
        },
        subject: 'OmniReach AI Live Test: Automated Email Successful!',
        body: 'Hello!\n\nThis is a verified live test from your OmniReach AI outreach system.\n\nYour email connection is active. All automated outreach emails in your batch will be delivered directly to prospective client inboxes.\n\nBest regards,\nOmniReach AI Engine',
        channelSettings: formData,
        senderName: 'OmniReach AI',
        accessToken,
      });

      if (data.delivered) {
        setTestStatus('success');
        setTestResultMsg(`Email sent directly to ${testEmailTo}! Check your inbox.`);
      } else {
        setTestStatus('error');
        setTestResultMsg(data.errorDetail || 'Failed to deliver email. Please check your API key.');
      }
    } catch (err: any) {
      setTestStatus('error');
      setTestResultMsg(err.message || 'Connection failed');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSettings(formData);
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 600);
  };

  const resultNote = (status: 'idle' | 'sending' | 'success' | 'error' | 'loading', message: string) =>
    status === 'success' ? <Note tone="success">{message}</Note> : status === 'error' ? <Note tone="error">{message}</Note> : null;

  const testEmailBox = (
    <AdvancedSection label="Send a test email">
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          placeholder="you@company.com"
          value={testEmailTo}
          onChange={(e) => setTestEmailTo(e.target.value)}
          className={inputClass}
        />
        <button type="button" onClick={handleSendTestEmail} disabled={testStatus === 'sending'} className={`${primaryButtonClass} shrink-0`}>
          {testStatus === 'sending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          <span>{testStatus === 'sending' ? 'Sending…' : 'Send Test'}</span>
        </button>
      </div>
      {resultNote(testStatus, testResultMsg)}
    </AdvancedSection>
  );

  const testWhatsAppBox = (
    <AdvancedSection label="Send a test WhatsApp message">
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="tel"
          placeholder="+971501234567"
          value={testWaTo}
          onChange={(e) => setTestWaTo(e.target.value)}
          className={`${inputClass} font-mono`}
        />
        <button type="button" onClick={handleSendTestWhatsApp} disabled={testWaStatus === 'sending'} className={`${primaryButtonClass} shrink-0`}>
          {testWaStatus === 'sending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          <span>{testWaStatus === 'sending' ? 'Sending…' : 'Send Test'}</span>
        </button>
      </div>
      {resultNote(testWaStatus, testWaResultMsg)}
    </AdvancedSection>
  );

  const domainStatusLabel: Record<string, string> = {
    verified: 'Verified',
    pending: 'Checking DNS…',
    not_started: 'Waiting for DNS records',
    failed: 'Verification failed',
    temporary_failure: 'Temporarily failing',
  };

  // Own sending domain on the platform's email account — what "automatic" sending sends from.
  const ownDomainPanel = (
    <Card
      title="Send from your own domain"
      aside={
        emailDomain.domain && (
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full border ${
              emailDomain.domain.status === 'verified'
                ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20'
                : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
            }`}
          >
            {domainStatusLabel[emailDomain.domain.status] || emailDomain.domain.status}
          </span>
        )
      }
    >
      {!emailDomain.domain ? (
        <>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Optional. Emails go out from our shared address until you add your company's domain — then they come from
            e.g. <span className="text-ink-secondary">outreach@yourcompany.com</span>.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <input
                type="text"
                value={fromLocalPart}
                onChange={(e) => setFromLocalPart(e.target.value)}
                className={`${inputClass} !w-28 font-mono`}
                aria-label="Address name"
              />
              <span className="text-xs text-ink-muted">@</span>
              <input
                type="text"
                placeholder="yourcompany.com"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                className={`${inputClass} font-mono`}
                aria-label="Domain"
              />
            </div>
            <button
              type="button"
              disabled={emailDomain.busy || !domainInput.trim()}
              onClick={() => emailDomain.add(domainInput, fromLocalPart)}
              className={`${secondaryButtonClass} shrink-0`}
            >
              {emailDomain.busy ? 'Adding…' : 'Add Domain'}
            </button>
          </div>
        </>
      ) : emailDomain.domain.status === 'verified' ? (
        <p className="text-[11px] text-ink-secondary">
          Emails go out from <strong className="text-ink">{emailDomain.domain.fromAddress}</strong>.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Add these records at your domain host (GoDaddy, Cloudflare, Namecheap…), then click Verify. Once verified,
            emails come from <strong className="text-ink-secondary">{emailDomain.domain.fromAddress}</strong>.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-[10px] font-mono">
              <thead className="bg-surface">
                <tr className="text-left text-ink-muted">
                  <th className="px-2 py-1.5 font-semibold">Type</th>
                  <th className="px-2 py-1.5 font-semibold">Name</th>
                  <th className="px-2 py-1.5 font-semibold">Value</th>
                  <th className="px-2 py-1.5 font-semibold">Priority</th>
                </tr>
              </thead>
              <tbody>
                {emailDomain.domain.records.map((r, i) => (
                  <tr key={i} className="align-top border-t border-border">
                    <td className="px-2 py-1.5">{r.type}</td>
                    <td className="px-2 py-1.5 break-all">
                      <button type="button" onClick={() => copyToClipboard(r.name, `dns-name-${i}`)} className="text-left hover:underline">
                        {copiedField === `dns-name-${i}` ? 'Copied' : r.name}
                      </button>
                    </td>
                    <td className="px-2 py-1.5 break-all">
                      <button type="button" onClick={() => copyToClipboard(r.value, `dns-value-${i}`)} className="text-left hover:underline">
                        {copiedField === `dns-value-${i}` ? 'Copied' : r.value}
                      </button>
                    </td>
                    <td className="px-2 py-1.5">{r.priority ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-ink-muted">Click a name or value to copy it.</p>
        </>
      )}
      {emailDomain.domain && (
        <div className="flex flex-wrap gap-2">
          {emailDomain.domain.status !== 'verified' && (
            <button type="button" disabled={emailDomain.busy} onClick={() => emailDomain.verify()} className={primaryButtonClass}>
              {emailDomain.busy ? 'Checking…' : 'Verify DNS'}
            </button>
          )}
          <button
            type="button"
            disabled={emailDomain.busy}
            onClick={() => {
              if (window.confirm(`Stop sending from ${emailDomain.domain!.domain}?`)) emailDomain.remove();
            }}
            className="text-[11px] text-ink-muted hover:text-rose-400 underline"
          >
            Remove domain
          </button>
        </div>
      )}
      {emailDomain.error && <Note tone="error">{emailDomain.error}</Note>}
    </Card>
  );

  // Gmail / Outlook "Connect" — sends from the org's own mailbox, no app password needed.
  const emailOAuthProvider = formData.emailProvider === 'outlook' ? 'outlook' : 'gmail';
  const emailOAuthLabel = emailOAuthProvider === 'gmail' ? 'Gmail' : 'Outlook';
  const emailOAuthConnectedHere = emailOAuth.status.connected && emailOAuth.status.provider === emailOAuthProvider;
  const emailOAuthPanel = (
    <Card title={`${emailOAuthLabel} account`}>
      {emailOAuthConnectedHere ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-emerald-300 flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Sending as {emailOAuth.status.connectedEmail || `your ${emailOAuthLabel} account`}
          </p>
          <button
            type="button"
            onClick={() => {
              // The server also switches the org back to automatic sending (lib/emailOAuth.ts).
              emailOAuth.disconnect();
              setFormData((prev) => ({ ...prev, emailProvider: 'resend' }));
              setEmailAdvancedOpen(false);
            }}
            className="text-[11px] text-ink-muted hover:text-rose-400 underline"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Sign in once and allow sending. Emails then go out from your own mailbox and appear in its Sent folder.
            {emailOAuth.status.connected && ` This replaces the ${emailOAuth.status.provider === 'gmail' ? 'Gmail' : 'Outlook'} account connected now.`}
          </p>
          <button
            type="button"
            disabled={emailOAuth.connecting || !userId}
            onClick={() => emailOAuth.connect(emailOAuthProvider)}
            className={primaryButtonClass}
          >
            {emailOAuth.connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
            <span>Connect {emailOAuthLabel}</span>
          </button>
        </>
      )}
      {emailOAuth.error && <Note tone="error">{emailOAuth.error}</Note>}
      {emailOAuthConnectedHere && testEmailBox}
    </Card>
  );

  // ---- Section status (one live line per section, from the health check) ----
  type Section = SetupSectionId;
  const whatsappStatus =
    formData.whatsAppProvider !== 'cloud_api'
      ? null
      : health?.whatsappToken && !health.whatsappToken.ok
        ? health.whatsappToken
        : health?.whatsapp || null;
  const sectionStatus: Record<Section, { ok: boolean; message: string } | null> = {
    whatsapp: whatsappStatus,
    email: health?.email || null,
    voice: health?.voice || null,
    calendar: health?.calendar || null,
    crm: crm?.connection
      ? crm.connection.lastError
        ? { ok: false, message: `${CRM_NAMES[crm.connection.provider]}: ${crm.connection.lastError}` }
        : {
            ok: true,
            message: `Connected to ${CRM_NAMES[crm.connection.provider]}${crm.connection.account ? ` (${crm.connection.account})` : ''}${
              crm.connection.lastSyncAt ? ` · last sync ${new Date(crm.connection.lastSyncAt).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''
            }.`,
          }
      : null,
    compliance: dnc ? { ok: true, message: `${dnc.total} number${dnc.total === 1 ? '' : 's'} and address${dnc.total === 1 ? '' : 'es'} on your list.` } : null,
    notifications: formData.slackWebhookUrl ? { ok: true, message: 'Slack notifications are on.' } : null,
    integrations: formData.n8nWebhookUrl ? { ok: true, message: 'Webhook is set.' } : null,
  };
  const sections: { id: Section; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'whatsapp', label: 'WhatsApp', icon: MessageSquare },
    { id: 'email', label: 'Email', icon: Mail },
    { id: 'voice', label: 'Voice Agent', icon: Phone },
    { id: 'calendar', label: 'Calendar', icon: Calendar },
    { id: 'crm', label: 'CRM', icon: Database },
    { id: 'compliance', label: 'Do not contact', icon: ShieldCheck },
    { id: 'notifications', label: 'Notifications', icon: Slack },
    { id: 'integrations', label: 'Integrations', icon: Network },
  ];
  const statusDot = (id: Section) => {
    const s = sectionStatus[id];
    return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${!s ? 'bg-border-strong' : s.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />;
  };
  const sectionProps = (id: Section) => ({
    status: sectionStatus[id],
    statusLoading: healthLoading && (id === 'whatsapp' ? formData.whatsAppProvider === 'cloud_api' : ['email', 'voice', 'calendar'].includes(id)),
    onRefreshStatus: accessToken ? reloadHealth : undefined,
  });

  const messageModeEditor = (templateEditor: React.ReactNode) => (
    <Card title="Message settings">
      <Field
        label="Message type"
        hint="Free text only reaches people who messaged you in the last 24 hours. For first contact (cold outreach), WhatsApp requires an approved template."
      >
        <Segmented
          value={formData.whatsappMessageMode || 'text'}
          onChange={(v) => setFormData({ ...formData, whatsappMessageMode: v })}
          options={[
            { value: 'text', label: 'Free text' },
            { value: 'template', label: 'Approved template' },
          ]}
        />
      </Field>
      {formData.whatsappMessageMode === 'template' && templateEditor}
    </Card>
  );

  const emailMethod: 'auto' | 'gmail' | 'outlook' | 'other' =
    formData.emailProvider === 'gmail' || formData.emailProvider === 'outlook'
      ? formData.emailProvider
      : emailAdvancedOpen
        ? 'other'
        : 'auto';
  const otherEmailProvider = (['smtp', 'resend', 'sendgrid', 'mailgun'] as const).includes(formData.emailProvider as any)
    ? (formData.emailProvider as 'smtp' | 'resend' | 'sendgrid' | 'mailgun')
    : 'smtp';

  const voiceLanguage = findVoiceLanguage(formData.vapiLanguage);
  const hasVoiceNumber = orgVoice.voice?.hasNumber || (hasSecret('vapiApiKey') && !!formData.vapiPhoneNumberId);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-2 sm:p-4"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="bg-surface/80 backdrop-blur-3xl border border-white/10 ring-1 ring-white/5 rounded-3xl shadow-modal max-w-4xl w-full h-[92vh] sm:h-[85vh] flex flex-col overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-brand-strong/20 text-brand-strong flex items-center justify-center">
                  <Settings className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-ink">Channel Setup</h2>
                  <p className="text-[11px] text-ink-muted">Connect the channels your AI uses to reach and reply to leads.</p>
                </div>
              </div>
              <button type="button" onClick={onClose} className="p-1.5 text-ink-muted hover:text-ink rounded-lg transition-colors" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col sm:flex-row">
              <nav className="shrink-0 sm:w-48 border-b sm:border-b-0 sm:border-r border-border p-2 sm:p-3 flex sm:flex-col gap-1 overflow-x-auto">
                {sections.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveSubTab(id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                      activeSubTab === id ? 'bg-brand-strong/15 text-ink' : 'text-ink-muted hover:text-ink hover:bg-surface-hover'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="flex-1 text-left">{label}</span>
                    {statusDot(id)}
                  </button>
                ))}
              </nav>

              <div className="flex-1 min-w-0 flex flex-col">
                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                  {activeSubTab === 'whatsapp' && (
                    <SetupSection
                      title="WhatsApp"
                      description="Send campaign messages and let the AI reply to customers on WhatsApp."
                      {...sectionProps('whatsapp')}
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <ChoiceCard
                          selected={formData.whatsAppProvider === 'cloud_api'}
                          onClick={() => setFormData({ ...formData, whatsAppProvider: 'cloud_api' })}
                          title="WhatsApp Business API"
                          description="Official Meta API. Sends automatically and the AI replies."
                          badge="Recommended"
                        />
                        <ChoiceCard
                          selected={formData.whatsAppProvider === 'web_direct'}
                          onClick={() => setFormData({ ...formData, whatsAppProvider: 'web_direct' })}
                          title="WhatsApp app (manual)"
                          description="Opens each chat in your own WhatsApp. No setup, no AI replies."
                        />
                        {whatsappMoreOpen && (
                          <>
                            <ChoiceCard
                              selected={formData.whatsAppProvider === 'twilio'}
                              onClick={() => setFormData({ ...formData, whatsAppProvider: 'twilio' })}
                              title="Twilio"
                              description="Send through your Twilio WhatsApp account."
                            />
                            <ChoiceCard
                              selected={formData.whatsAppProvider === 'webhook'}
                              onClick={() => setFormData({ ...formData, whatsAppProvider: 'webhook' })}
                              title="Custom webhook / BSP"
                              description="Route sends through n8n or a provider like 360dialog or Gupshup."
                            />
                          </>
                        )}
                      </div>
                      {!whatsappMoreOpen && (
                        <button type="button" onClick={() => setWhatsappMoreOpen(true)} className="text-[11px] font-medium text-ink-muted hover:text-ink underline">
                          Other providers (Twilio, custom webhook)
                        </button>
                      )}

                      {formData.whatsAppProvider === 'cloud_api' && (
                        <>
                          <Card title="Connect your number" step={1}>
                            <Field label="Access token">
                              <SecretInput
                                saved={!!formData.savedSecrets?.whatsappCloudApiKey}
                                placeholder="EAAxxxxxxxx…"
                                value={formData.whatsappCloudApiKey}
                                onChange={(v) => setSecret('whatsappCloudApiKey', v)}
                                className={`${inputClass} font-mono`}
                              />
                            </Field>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <Field label="Phone number ID">
                                <input
                                  type="text"
                                  placeholder="1234567890123456"
                                  value={formData.whatsappCloudPhoneId || ''}
                                  onChange={(e) => setFormData({ ...formData, whatsappCloudPhoneId: e.target.value })}
                                  className={`${inputClass} font-mono`}
                                />
                              </Field>
                              <Field label="Business account ID">
                                <input
                                  type="text"
                                  placeholder="Next to Phone number ID"
                                  value={formData.whatsappBusinessAccountId || ''}
                                  onChange={(e) => setFormData({ ...formData, whatsappBusinessAccountId: e.target.value })}
                                  className={`${inputClass} font-mono`}
                                />
                              </Field>
                            </div>
                            <p className="text-[10px] text-ink-muted">
                              All three are on your Meta app's{' '}
                              <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" className="text-ink-secondary underline">
                                WhatsApp → API Setup
                              </a>{' '}
                              page. Use a permanent token (System User) — the temporary one expires in 24 hours.
                            </p>
                          </Card>

                          <Card title="Receive replies" step={2}>
                            <Field label={<>App secret <span className="text-rose-400">· required for replies</span></>}>
                              <SecretInput
                                saved={!!formData.savedSecrets?.whatsappAppSecret}
                                placeholder="Meta app → Settings → Basic → App secret"
                                value={formData.whatsappAppSecret}
                                onChange={(v) => setSecret('whatsappAppSecret', v)}
                                className={`${inputClass} font-mono`}
                              />
                            </Field>
                            {!hasSecret('whatsappAppSecret') && (
                              <Note tone="warn">Without the app secret, incoming WhatsApp messages are rejected and the AI won't reply.</Note>
                            )}
                            <p className="text-[11px] text-ink-muted">
                              In your Meta app → WhatsApp → Configuration → Webhook, paste these two values and subscribe to <strong className="text-ink-secondary">messages</strong>:
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <CopyRow
                                label="Callback URL"
                                value={`${typeof window !== 'undefined' ? window.location.origin : ''}/api/whatsapp/webhook`}
                                copied={copiedField === 'url'}
                                onCopy={() => copyToClipboard(`${window.location.origin}/api/whatsapp/webhook`, 'url')}
                              />
                              <CopyRow
                                label="Verify token"
                                value={verifyToken === null ? 'Loading…' : verifyToken || 'Not configured on the server'}
                                copied={copiedField === 'token'}
                                onCopy={() => verifyToken && copyToClipboard(verifyToken, 'token')}
                                disabled={!verifyToken}
                              />
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button type="button" onClick={handleSubscribeApp} disabled={subscribeStatus === 'loading'} className={secondaryButtonClass}>
                                {subscribeStatus === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                <span>Subscribe app to my WhatsApp account</span>
                              </button>
                              <span className="text-[10px] text-ink-muted">Last step — Meta has no button for this.</span>
                            </div>
                            {resultNote(subscribeStatus, subscribeMsg)}
                          </Card>

                          {messageModeEditor(
                            <>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <Field label="Template name">
                                  <input
                                    type="text"
                                    placeholder="outreach_intro"
                                    value={formData.whatsappTemplateName || ''}
                                    onChange={(e) => setFormData({ ...formData, whatsappTemplateName: e.target.value })}
                                    className={`${inputClass} font-mono`}
                                  />
                                </Field>
                                <Field label="Language code">
                                  <input
                                    type="text"
                                    placeholder="en_US"
                                    value={formData.whatsappTemplateLanguage || ''}
                                    onChange={(e) => setFormData({ ...formData, whatsappTemplateLanguage: e.target.value })}
                                    className={`${inputClass} font-mono`}
                                  />
                                </Field>
                              </div>
                              <p className="text-[10px] text-ink-muted">
                                Create templates in{' '}
                                <a href="https://business.facebook.com/wa/manage/message-templates/" target="_blank" rel="noreferrer" className="text-ink-secondary underline">
                                  WhatsApp Manager
                                </a>{' '}
                                and use the exact name and language once approved.
                              </p>
                              {renderTemplateVariableEditor('whatsappTemplateVariables')}
                              <AdvancedSection label="Follow-up template (optional)">
                                <p className="text-[10px] text-ink-muted">
                                  Lets campaign follow-ups also go out on WhatsApp — WhatsApp only allows an approved template once 24 hours pass without a reply. Without one, follow-ups go by email only.
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                  <Field label="Follow-up template name">
                                    <input
                                      type="text"
                                      placeholder="outreach_followup"
                                      value={formData.whatsappFollowupTemplateName || ''}
                                      onChange={(e) => setFormData({ ...formData, whatsappFollowupTemplateName: e.target.value })}
                                      className={`${inputClass} font-mono`}
                                    />
                                  </Field>
                                  <Field label="Language code">
                                    <input
                                      type="text"
                                      placeholder={formData.whatsappTemplateLanguage || 'en_US'}
                                      value={formData.whatsappFollowupTemplateLanguage || ''}
                                      onChange={(e) => setFormData({ ...formData, whatsappFollowupTemplateLanguage: e.target.value })}
                                      className={`${inputClass} font-mono`}
                                    />
                                  </Field>
                                </div>
                                {formData.whatsappFollowupTemplateName && renderTemplateVariableEditor('whatsappFollowupTemplateVariables')}
                              </AdvancedSection>
                            </>
                          )}

                          <AdvancedSection label="Sending limits">
                            <Field
                              label="Safe daily send limit"
                              hint="New numbers usually start at 250 conversations a day and grow as quality improves. Bigger batches are spread across days automatically."
                            >
                              <input
                                type="number"
                                min={1}
                                value={formData.safeDailyWhatsAppLimit ?? 250}
                                onChange={(e) => setFormData({ ...formData, safeDailyWhatsAppLimit: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                                className={`${inputClass} !w-40 font-mono`}
                              />
                            </Field>
                          </AdvancedSection>
                          {testWhatsAppBox}
                          <AdvancedSection label="Sent, but nothing arrives?">
                            <ul className="list-disc pl-4 space-y-1 text-[11px] text-ink-muted leading-relaxed">
                              <li>Test apps can only message up to 5 numbers verified under WhatsApp → API Setup.</li>
                              <li>The temporary access token expires after 24 hours — use a permanent System User token.</li>
                              <li>Brand-new numbers may be held by Meta for quality review before delivering.</li>
                              <li>Outside the 24-hour reply window, only approved templates are delivered.</li>
                            </ul>
                          </AdvancedSection>
                        </>
                      )}

                      {formData.whatsAppProvider === 'twilio' && (
                        <>
                          <Card title="Twilio account">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <Field label="Account SID">
                                <input
                                  type="text"
                                  placeholder="ACxxxxxxxx…"
                                  value={formData.twilioAccountSid || ''}
                                  onChange={(e) => setFormData({ ...formData, twilioAccountSid: e.target.value })}
                                  className={`${inputClass} font-mono`}
                                />
                              </Field>
                              <Field label="Auth token">
                                <SecretInput
                                  saved={!!formData.savedSecrets?.twilioAuthToken}
                                  placeholder="••••••••"
                                  value={formData.twilioAuthToken}
                                  onChange={(v) => setSecret('twilioAuthToken', v)}
                                  className={`${inputClass} font-mono`}
                                />
                              </Field>
                            </div>
                            <Field label="WhatsApp sender number" hint="Leave blank to use the Twilio sandbox (+1 415 523 8886).">
                              <input
                                type="text"
                                placeholder="+14155238886"
                                value={formData.twilioFromNumber || ''}
                                onChange={(e) => setFormData({ ...formData, twilioFromNumber: e.target.value })}
                                className={`${inputClass} font-mono`}
                              />
                            </Field>
                            <Note>Twilio sends campaign messages only — AI replies need the WhatsApp Business API.</Note>
                          </Card>
                          {messageModeEditor(
                            <>
                              <Field
                                label="Content SID"
                                hint={
                                  <>
                                    From the{' '}
                                    <a href="https://console.twilio.com/us1/develop/sms/content-template-builder" target="_blank" rel="noreferrer" className="text-ink-secondary underline">
                                      Twilio Content Template Builder
                                    </a>
                                    , once WhatsApp approves it (starts with "HX").
                                  </>
                                }
                              >
                                <input
                                  type="text"
                                  placeholder="HXxxxxxxxx…"
                                  value={formData.twilioContentSid || ''}
                                  onChange={(e) => setFormData({ ...formData, twilioContentSid: e.target.value })}
                                  className={`${inputClass} font-mono`}
                                />
                              </Field>
                              {renderTemplateVariableEditor('twilioContentVariables')}
                              <AdvancedSection label="Follow-up template (optional)">
                                <Field
                                  label="Follow-up Content SID"
                                  hint="A second approved template for campaign follow-ups on WhatsApp. Without one, follow-ups go by email only."
                                >
                                  <input
                                    type="text"
                                    placeholder="HXxxxxxxxx…"
                                    value={formData.twilioFollowupContentSid || ''}
                                    onChange={(e) => setFormData({ ...formData, twilioFollowupContentSid: e.target.value })}
                                    className={`${inputClass} font-mono`}
                                  />
                                </Field>
                                {formData.twilioFollowupContentSid && renderTemplateVariableEditor('twilioFollowupContentVariables')}
                              </AdvancedSection>
                            </>
                          )}
                          {testWhatsAppBox}
                        </>
                      )}

                      {formData.whatsAppProvider === 'webhook' && (
                        <Card title="Custom webhook / BSP">
                          <p className="text-[11px] text-ink-muted leading-relaxed">
                            Each WhatsApp send posts the lead and message to your webhook (set under Integrations). Point it at a
                            workflow that delivers through your provider — 360dialog, Gupshup, Infobip, WATI…
                          </p>
                          {!formData.n8nWebhookUrl && (
                            <Note tone="warn">
                              No webhook URL yet —{' '}
                              <button type="button" onClick={() => setActiveSubTab('integrations')} className="underline">
                                add one under Integrations
                              </button>
                              .
                            </Note>
                          )}
                          {testWhatsAppBox}
                        </Card>
                      )}
                    </SetupSection>
                  )}

                  {activeSubTab === 'email' && (
                    <SetupSection title="Email" description="How campaign emails and AI replies are sent." {...sectionProps('email')}>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <ChoiceCard
                          selected={emailMethod === 'auto'}
                          onClick={() => {
                            // 'resend' with no org key is the automatic platform-sent path (lib/emailSender.ts).
                            setFormData({ ...formData, emailProvider: 'resend' });
                            setEmailAdvancedOpen(false);
                          }}
                          title="Automatic"
                          description="We send for you. Nothing to set up."
                          badge="Recommended"
                        />
                        <ChoiceCard
                          selected={emailMethod === 'gmail'}
                          onClick={() => {
                            setFormData({ ...formData, emailProvider: 'gmail' });
                            setEmailAdvancedOpen(false);
                          }}
                          title="Gmail"
                          description="Send from your Gmail or Google Workspace mailbox."
                        />
                        <ChoiceCard
                          selected={emailMethod === 'outlook'}
                          onClick={() => {
                            setFormData({ ...formData, emailProvider: 'outlook' });
                            setEmailAdvancedOpen(false);
                          }}
                          title="Outlook"
                          description="Send from your Outlook or Microsoft 365 mailbox."
                        />
                        <ChoiceCard
                          selected={emailMethod === 'other'}
                          onClick={() => {
                            setEmailAdvancedOpen(true);
                            if (!['smtp', 'sendgrid', 'mailgun'].includes(formData.emailProvider)) setFormData({ ...formData, emailProvider: 'smtp' });
                          }}
                          title="Other"
                          description="SMTP (Zoho, cPanel…) or an email API key."
                        />
                      </div>

                      {emailMethod === 'auto' && (
                        <>
                          {userId && ownDomainPanel}
                          {testEmailBox}
                        </>
                      )}

                      {(emailMethod === 'gmail' || emailMethod === 'outlook') && emailOAuthPanel}

                      {emailMethod === 'other' && (
                        <Card title="Provider">
                          <Segmented
                            value={otherEmailProvider}
                            onChange={(v) => setFormData({ ...formData, emailProvider: v })}
                            options={[
                              { value: 'smtp', label: 'SMTP' },
                              { value: 'resend', label: 'Resend' },
                              { value: 'sendgrid', label: 'SendGrid' },
                              { value: 'mailgun', label: 'Mailgun' },
                            ]}
                          />

                          {formData.emailProvider === 'smtp' ? (
                            <>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div className="sm:col-span-2">
                                  <Field label="SMTP host">
                                    <input
                                      type="text"
                                      placeholder="smtp.zoho.com"
                                      value={formData.smtpHost || ''}
                                      onChange={(e) => setFormData({ ...formData, smtpHost: e.target.value })}
                                      className={`${inputClass} font-mono`}
                                    />
                                  </Field>
                                </div>
                                <Field label="Port">
                                  <input
                                    type="number"
                                    placeholder="587"
                                    value={formData.smtpPort ?? ''}
                                    onChange={(e) => setFormData({ ...formData, smtpPort: e.target.value ? Number(e.target.value) : undefined })}
                                    className={`${inputClass} font-mono`}
                                  />
                                </Field>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <Field label="Username">
                                  <input
                                    type="text"
                                    placeholder="you@company.com"
                                    value={formData.smtpUser || ''}
                                    onChange={(e) => setFormData({ ...formData, smtpUser: e.target.value })}
                                    className={`${inputClass} font-mono`}
                                  />
                                </Field>
                                <Field label="Password / app password">
                                  <SecretInput
                                    saved={!!formData.savedSecrets?.smtpPass}
                                    placeholder="••••••••"
                                    value={formData.smtpPass}
                                    onChange={(v) => setSecret('smtpPass', v)}
                                    className={`${inputClass} font-mono`}
                                  />
                                </Field>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                                <Field label="From address (optional)">
                                  <input
                                    type="email"
                                    placeholder="Defaults to the username"
                                    value={formData.smtpFromEmail || ''}
                                    onChange={(e) => setFormData({ ...formData, smtpFromEmail: e.target.value })}
                                    className={`${inputClass} font-mono`}
                                  />
                                </Field>
                                <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary pb-2">
                                  <input
                                    type="checkbox"
                                    checked={!!formData.smtpSecure}
                                    onChange={(e) => setFormData({ ...formData, smtpSecure: e.target.checked })}
                                    className="accent-[#128C7E]"
                                  />
                                  Use SSL (port 465)
                                </label>
                              </div>
                              <AdvancedSection label="Settings for common providers">
                                <ul className="space-y-1 text-[11px] text-ink-muted leading-relaxed">
                                  <li>
                                    <strong className="text-ink-secondary">Zoho:</strong> smtp.zoho.com (EU: smtp.zoho.eu), port 587, with an{' '}
                                    <a href="https://accounts.zoho.com/home#security/app-password" target="_blank" rel="noreferrer" className="underline">
                                      app password
                                    </a>
                                    .
                                  </li>
                                  <li>
                                    <strong className="text-ink-secondary">Office 365:</strong> smtp.office365.com, port 587 — or just use Outlook above.
                                  </li>
                                  <li>
                                    <strong className="text-ink-secondary">Gmail:</strong> smtp.gmail.com, port 587, with an{' '}
                                    <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="underline">
                                      app password
                                    </a>{' '}
                                    — or just use Gmail above.
                                  </li>
                                </ul>
                              </AdvancedSection>
                            </>
                          ) : (
                            <>
                              <Field
                                label="API key"
                                hint={
                                  formData.emailProvider === 'resend'
                                    ? 'From resend.com → API Keys.'
                                    : formData.emailProvider === 'sendgrid'
                                      ? 'From app.sendgrid.com, with Mail Send permission.'
                                      : 'From app.mailgun.com → Settings → API Keys.'
                                }
                              >
                                <SecretInput
                                  saved={!!formData.savedSecrets?.emailApiKey}
                                  placeholder={formData.emailProvider === 'resend' ? 're_…' : formData.emailProvider === 'sendgrid' ? 'SG.…' : 'key-…'}
                                  value={formData.emailApiKey}
                                  onChange={(v) => setSecret('emailApiKey', v)}
                                  className={`${inputClass} font-mono`}
                                />
                              </Field>
                              {formData.emailProvider === 'mailgun' && (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                  <Field label="Sending domain">
                                    <input
                                      type="text"
                                      placeholder="mg.yourdomain.com"
                                      value={formData.mailgunDomain || ''}
                                      onChange={(e) => setFormData({ ...formData, mailgunDomain: e.target.value })}
                                      className={`${inputClass} font-mono`}
                                    />
                                  </Field>
                                  <Field label="Region">
                                    <select
                                      value={formData.mailgunRegion || 'us'}
                                      onChange={(e) => setFormData({ ...formData, mailgunRegion: e.target.value as 'us' | 'eu' })}
                                      className={inputClass}
                                    >
                                      <option value="us">US</option>
                                      <option value="eu">EU</option>
                                    </select>
                                  </Field>
                                </div>
                              )}
                            </>
                          )}
                          {testEmailBox}
                        </Card>
                      )}

                      {health?.emailReplyTracking && !health.emailReplyTracking.ok && (
                        <Note tone="warn">Reply tracking: {health.emailReplyTracking.message}</Note>
                      )}
                    </SetupSection>
                  )}

                  {activeSubTab === 'voice' && (
                    <SetupSection
                      title="AI Voice Agent"
                      description="An AI that calls your leads and answers your phone line, then books meetings."
                      {...sectionProps('voice')}
                    >
                      <Card
                        title="Phone number"
                        aside={
                          orgVoice.voice?.inboundEnabled && (
                            <span className="text-[10px] text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                              Answers incoming calls
                            </span>
                          )
                        }
                      >
                        {hasVoiceNumber ? (
                          <>
                            <p className="text-xs text-ink-secondary">
                              {orgVoice.voice?.phoneNumber ? (
                                <>
                                  Your number: <strong className="font-mono text-ink">{orgVoice.voice.phoneNumber}</strong>
                                </>
                              ) : (
                                'Using the number on your own Vapi account.'
                              )}
                            </p>
                            {!orgVoice.voice?.inboundEnabled && (
                              <div className="flex flex-wrap items-center gap-2">
                                <button type="button" onClick={orgVoice.enableInbound} disabled={orgVoice.enabling || !userId} className={secondaryButtonClass}>
                                  {orgVoice.enabling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
                                  <span>Let the AI answer incoming calls</span>
                                </button>
                                <span className="text-[10px] text-ink-muted">It picks up, helps the caller and can book a meeting.</span>
                              </div>
                            )}
                            <Field
                              label="Daily call limit"
                              hint="The most calls your number makes in 24 hours. Too many calls from one number gets it marked as spam — new numbers should stay around 100–150."
                            >
                              <select
                                value={formData.voiceDailyCallLimit ?? 150}
                                onChange={(e) => setFormData({ ...formData, voiceDailyCallLimit: Number(e.target.value) })}
                                className={`${inputClass} !w-40`}
                              >
                                {[50, 100, 150, 200, 300, 500].map((n) => (
                                  <option key={n} value={n}>
                                    {n} calls / day
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field
                              label="Greeting for incoming calls (optional)"
                              hint={
                                formData.vapiLanguage && !formData.vapiLanguage.startsWith('en')
                                  ? 'Leave blank and the agent greets callers in your call language.'
                                  : 'Saved with Save Settings below.'
                              }
                            >
                              <input
                                type="text"
                                placeholder={`Hi, thanks for calling${campaignSettings?.companyName ? ` ${campaignSettings.companyName}` : ''}! How can I help you today?`}
                                value={formData.vapiInboundFirstMessage || ''}
                                onChange={(e) => setFormData({ ...formData, vapiInboundFirstMessage: e.target.value })}
                                className={inputClass}
                              />
                            </Field>
                          </>
                        ) : (
                          <Note tone="warn">No phone number is assigned to your workspace yet — contact support to get your own number.</Note>
                        )}
                        {orgVoice.error && <Note tone="error">{orgVoice.error}</Note>}
                      </Card>

                      <Card
                        title="Voice agent"
                        aside={
                          isLoadingVapiPrompt && (
                            <span className="text-[11px] text-ink-muted flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Loading…
                            </span>
                          )
                        }
                      >
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div className="sm:col-span-2">
                            <Field label="Language">
                              <select
                                value={formData.vapiLanguage || ''}
                                onChange={(e) => setFormData({ ...formData, vapiLanguage: e.target.value || undefined })}
                                className={inputClass}
                              >
                                <option value="">English — default voice</option>
                                {(['Auto', 'Americas', 'Europe', 'India', 'Middle East & Asia'] as const).map((region) => (
                                  <optgroup key={region} label={region === 'Auto' ? 'Any language' : region}>
                                    {VOICE_LANGUAGES.filter((l) => l.region === region).map((l) => (
                                      <option key={l.code} value={l.code}>
                                        {l.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            </Field>
                          </div>
                          <Field label="Voice">
                            <select
                              value={formData.vapiVoiceGender || 'female'}
                              disabled={!formData.vapiLanguage}
                              onChange={(e) => setFormData({ ...formData, vapiVoiceGender: e.target.value as 'female' | 'male' })}
                              className={`${inputClass} disabled:opacity-50`}
                            >
                              <option value="female">Female</option>
                              <option value="male">Male</option>
                            </select>
                          </Field>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <Field
                            label="Say it's an AI"
                            hint="Required by law for people in the EU and the US. Not required in India or the Gulf today."
                          >
                            <select
                              value={formData.voiceAiDisclosureMode || (formData.voiceAiDisclosure === false ? 'never' : 'required')}
                              onChange={(e) => setFormData({ ...formData, voiceAiDisclosureMode: e.target.value as 'required' | 'always' | 'never' })}
                              className={inputClass}
                            >
                              <option value="required">Only where required (EU, US)</option>
                              <option value="always">On every call</option>
                              <option value="never">Never — I have legal advice</option>
                            </select>
                          </Field>
                          <Field
                            label="Recording notice"
                            hint="Calls are recorded. Telling people is required in the UAE, India (DPDP Act), the UK, the EU and many US states."
                          >
                            <select
                              value={formData.voiceRecordingNotice === false ? 'off' : 'on'}
                              onChange={(e) => setFormData({ ...formData, voiceRecordingNotice: e.target.value === 'on' })}
                              className={inputClass}
                            >
                              <option value="on">Say "this call may be recorded"</option>
                              <option value="off">Don't say it</option>
                            </select>
                          </Field>
                          <div className="sm:col-span-2">
                            <Field
                              label="US numbers"
                              hint={'US law (TCPA) requires a lead\'s prior written consent before AI marketing calls. Mark leads "Agreed to be called" on the Leads page, or add a Consent column to your spreadsheet.'}
                            >
                              <select
                                value={formData.voiceUsConsentRequired === false ? 'off' : 'on'}
                                onChange={(e) => setFormData({ ...formData, voiceUsConsentRequired: e.target.value === 'on' })}
                                className={inputClass}
                              >
                                <option value="on">Only call US leads who agreed to be called</option>
                                <option value="off">Don't check — I have legal advice</option>
                              </select>
                            </Field>
                          </div>
                        </div>
                        <Field
                          label="First message"
                          hint={
                            voiceLanguage && voiceLanguage.code !== 'auto'
                              ? `Write this in ${voiceLanguage.label}. The instructions below can stay in English.`
                              : 'What the agent says when the lead picks up.'
                          }
                        >
                          <input
                            type="text"
                            placeholder="Hi! This is Alex calling from…"
                            value={formData.vapiFirstMessage || ''}
                            onChange={(e) => setFormData({ ...formData, vapiFirstMessage: e.target.value })}
                            className={inputClass}
                          />
                        </Field>
                        <Field label="Instructions">
                          <textarea
                            rows={8}
                            placeholder="You are Alex, a friendly sales rep for … Your goal is to book a 30-minute intro call."
                            value={formData.vapiSystemPrompt || ''}
                            onChange={(e) => setFormData({ ...formData, vapiSystemPrompt: e.target.value })}
                            className={`${inputClass} font-mono resize-y`}
                          />
                        </Field>
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={handleSyncVapiAssistant}
                            disabled={isSyncingVapi || !formData.vapiSystemPrompt || !formData.vapiFirstMessage}
                            className={primaryButtonClass}
                          >
                            {isSyncingVapi ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
                            <span>{isSyncingVapi ? 'Saving…' : 'Save voice agent'}</span>
                          </button>
                          <span className="text-[10px] text-ink-muted">Goes live right away — language and voice included.</span>
                        </div>
                        {vapiSyncResult && <Note tone={vapiSyncResult.ok ? 'success' : 'error'}>{vapiSyncResult.message}</Note>}
                      </Card>

                      <Card title="If they don't answer">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <Field label="Call attempts">
                            <select
                              value={formData.voiceRetryAttempts ?? 3}
                              onChange={(e) => setFormData({ ...formData, voiceRetryAttempts: Number(e.target.value) })}
                              className={inputClass}
                            >
                              <option value={1}>1 — don't call again</option>
                              <option value={2}>2 tries</option>
                              <option value={3}>3 tries</option>
                              <option value={4}>4 tries</option>
                              <option value={5}>5 tries</option>
                            </select>
                          </Field>
                          <Field label="Time between tries">
                            <select
                              value={formData.voiceRetryHours ?? 3}
                              disabled={(formData.voiceRetryAttempts ?? 3) <= 1}
                              onChange={(e) => setFormData({ ...formData, voiceRetryHours: Number(e.target.value) })}
                              className={`${inputClass} disabled:opacity-50`}
                            >
                              {[1, 2, 3, 4, 6, 24].map((h) => (
                                <option key={h} value={h}>
                                  {h === 24 ? 'Next day' : `${h} hour${h === 1 ? '' : 's'}`}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Then">
                            <select
                              value={formData.voiceFallback ?? 'whatsapp_email'}
                              onChange={(e) => setFormData({ ...formData, voiceFallback: e.target.value as 'whatsapp_email' | 'email' | 'none' })}
                              className={inputClass}
                            >
                              <option value="whatsapp_email">Message on WhatsApp (or email)</option>
                              <option value="email">Send an email</option>
                              <option value="none">Do nothing</option>
                            </select>
                          </Field>
                        </div>
                        <p className="text-[10px] text-ink-muted">
                          Retries only happen during the lead's local business hours. A call that fails to connect is retried after 10 minutes.
                        </p>
                        {(formData.voiceFallback ?? 'whatsapp_email') !== 'none' && (
                          <Field
                            label="Follow-up message"
                            hint={
                              <>
                                Sent after the last try. {'{{first_name}}'}, {'{{company_name}}'} and {'{{sender_name}}'} are filled in. When they reply,
                                the AI takes over and books the meeting.
                                {formData.whatsAppProvider === 'cloud_api' && formData.whatsappMessageMode === 'template'
                                  ? ' On WhatsApp your approved template is sent instead, since WhatsApp requires one for first contact.'
                                  : ''}
                              </>
                            }
                          >
                            <textarea
                              rows={3}
                              placeholder={DEFAULT_VOICE_FALLBACK_MESSAGE}
                              value={formData.voiceFallbackMessage || ''}
                              onChange={(e) => setFormData({ ...formData, voiceFallbackMessage: e.target.value })}
                              className={`${inputClass} resize-y`}
                            />
                          </Field>
                        )}
                        <Field
                          label="Voicemail message (optional)"
                          hint={
                            formData.vapiLanguage && !formData.vapiLanguage.startsWith('en')
                              ? 'If voicemail picks up, the agent leaves this. Leave blank to hang up without a message.'
                              : 'If voicemail picks up, the agent leaves this short message. Leave blank for a friendly default.'
                          }
                        >
                          <input
                            type="text"
                            placeholder="Hi, sorry I missed you — I'll send you a quick message, or call me back on this number."
                            value={formData.voicemailMessage || ''}
                            onChange={(e) => setFormData({ ...formData, voicemailMessage: e.target.value })}
                            className={inputClass}
                          />
                        </Field>
                      </Card>

                      <AdvancedSection label="Use your own Vapi account">
                        <p className="text-[11px] text-ink-muted leading-relaxed">
                          Only if you want separate Vapi billing and numbers. Leave blank to use ours. The assistant and phone
                          number IDs are only used together with your own API key.
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <Field label="Private API key">
                            <SecretInput
                              saved={!!formData.savedSecrets?.vapiApiKey}
                              placeholder="Vapi → API Keys → Private"
                              value={formData.vapiApiKey}
                              onChange={(v) => setSecret('vapiApiKey', v)}
                              className={`${inputClass} font-mono`}
                            />
                          </Field>
                          <Field label="Public key" hint="Powers the in-browser live demo.">
                            <input
                              type="text"
                              placeholder="Vapi → API Keys → Public"
                              value={formData.vapiPublicKey || ''}
                              onChange={(e) => setFormData({ ...formData, vapiPublicKey: e.target.value })}
                              className={`${inputClass} font-mono`}
                            />
                          </Field>
                          <Field label="Assistant ID" hint="Filled in automatically when you save the voice agent.">
                            <input
                              type="text"
                              placeholder="c75e06e1-…"
                              value={formData.vapiAssistantId || ''}
                              onChange={(e) => {
                                setVapiPromptLoaded(false);
                                setFormData({ ...formData, vapiAssistantId: e.target.value });
                              }}
                              className={`${inputClass} font-mono`}
                            />
                          </Field>
                          <Field label="Phone number ID" hint="Vapi's ID for the number, not the number itself.">
                            <input
                              type="text"
                              placeholder="Vapi → Phone Numbers"
                              value={formData.vapiPhoneNumberId || ''}
                              onChange={(e) => setFormData({ ...formData, vapiPhoneNumberId: e.target.value })}
                              className={`${inputClass} font-mono`}
                            />
                          </Field>
                        </div>
                      </AdvancedSection>
                    </SetupSection>
                  )}

                  {activeSubTab === 'calendar' && (
                    <SetupSection
                      title="Calendar"
                      description="Where the AI books meetings — with a Google Meet or Teams link sent to the lead."
                      {...sectionProps('calendar')}
                    >
                      {!userId ? (
                        <Note tone="warn">Sign in to a workspace to connect a calendar.</Note>
                      ) : (
                        <>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <Card
                              title="Google Calendar"
                              aside={googleCalendar.status.connected && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                            >
                              {googleCalendar.status.connected ? (
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs text-ink-secondary truncate">{googleCalendar.status.connectedEmail || 'Connected'}</span>
                                  <button type="button" onClick={googleCalendar.connect} className="text-[11px] text-ink-muted hover:text-ink underline shrink-0">
                                    Reconnect
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <p className="text-[11px] text-ink-muted">Books meetings with a Google Meet link.</p>
                                  <button type="button" onClick={googleCalendar.connect} disabled={googleCalendar.connecting} className={primaryButtonClass}>
                                    <Calendar className="w-3.5 h-3.5" />
                                    {googleCalendar.connecting ? 'Redirecting…' : 'Connect Google'}
                                    <ExternalLink className="w-3 h-3" />
                                  </button>
                                </>
                              )}
                              {googleCalendar.error && <Note tone="error">{googleCalendar.error}</Note>}
                            </Card>

                            <Card
                              title="Outlook Calendar"
                              aside={microsoftCalendar.status.connected && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                            >
                              {googleCalendar.status.connected ? (
                                <p className="text-[11px] text-ink-muted">Google Calendar is in use. Only one calendar can be connected.</p>
                              ) : microsoftCalendar.status.connected ? (
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs text-ink-secondary truncate">{microsoftCalendar.status.connectedEmail || 'Connected'}</span>
                                  <button type="button" onClick={microsoftCalendar.connect} className="text-[11px] text-ink-muted hover:text-ink underline shrink-0">
                                    Reconnect
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <p className="text-[11px] text-ink-muted">Books meetings with a Microsoft Teams link.</p>
                                  <button type="button" onClick={microsoftCalendar.connect} disabled={microsoftCalendar.connecting} className={primaryButtonClass}>
                                    <Calendar className="w-3.5 h-3.5" />
                                    {microsoftCalendar.connecting ? 'Redirecting…' : 'Connect Outlook'}
                                    <ExternalLink className="w-3 h-3" />
                                  </button>
                                </>
                              )}
                              {microsoftCalendar.error && <Note tone="error">{microsoftCalendar.error}</Note>}
                            </Card>
                          </div>
                          {microsoftCalendar.status.connected && !googleCalendar.status.connected && (
                            <Note>Connecting Google switches the AI over to Google Calendar.</Note>
                          )}
                        </>
                      )}
                    </SetupSection>
                  )}

                  {activeSubTab === 'crm' && (
                    <SetupSection
                      title="CRM"
                      description="Keep your CRM up to date automatically — and import your contacts from it."
                      {...sectionProps('crm')}
                    >
                      {!accessToken ? (
                        <Note tone="warn">Sign in to a workspace to connect a CRM.</Note>
                      ) : !crm ? (
                        <Note>Loading…</Note>
                      ) : crm.connection ? (
                        <>
                          <Card title={CRM_NAMES[crm.connection.provider]} aside={<CheckCircle2 className="w-4 h-4 text-emerald-400" />}>
                            <ul className="text-[11px] text-ink-muted space-y-1 list-disc pl-4">
                              <li>Every lead OmniReach contacts is created or updated in {CRM_NAMES[crm.connection.provider]}.</li>
                              <li>Call outcomes and summaries, replies and opt-outs are added as notes/activities.</li>
                              <li>Meetings the AI books are added to the lead.</li>
                            </ul>
                            {(crm.pending > 0 || crm.failed > 0) && (
                              <p className="text-[11px] text-ink-muted">
                                {crm.pending} waiting to sync{crm.failed ? ` · ${crm.failed} couldn't be synced after several tries` : ''}
                              </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={!!crmBusy}
                                onClick={async () => {
                                  setCrmBusy('sync');
                                  const r = await dncCall('crm-sync', {});
                                  if (r) setCrm(r);
                                  setCrmBusy(null);
                                }}
                                className={secondaryButtonClass}
                              >
                                <RefreshCw className={`w-3.5 h-3.5 ${crmBusy === 'sync' ? 'animate-spin' : ''}`} />
                                <span>Sync now</span>
                              </button>
                              {onImportLeads && (
                                <button type="button" disabled={!!crmBusy} onClick={importCrm} className={primaryButtonClass}>
                                  {crmBusy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
                                  <span>Import leads from {CRM_NAMES[crm.connection.provider]}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={!!crmBusy}
                                onClick={async () => {
                                  if (!window.confirm(`Disconnect ${CRM_NAMES[crm.connection!.provider]}? Nothing already in it is changed.`)) return;
                                  const r = await dncCall('crm-disconnect', {});
                                  if (r && !r.ok) setCrmNote({ ok: false, text: r.error });
                                  await loadCrm();
                                }}
                                className="text-[11px] text-ink-muted hover:text-rose-400 underline"
                              >
                                Disconnect
                              </button>
                            </div>
                          </Card>
                        </>
                      ) : crm.available.length === 0 ? (
                        <Note tone="warn">No CRM is set up on the platform yet — contact support.</Note>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          {crm.available.map((id) => (
                            <Card key={id} title={CRM_NAMES[id]}>
                              <p className="text-[11px] text-ink-muted">
                                {id === 'hubspot' ? 'Contacts, notes and meetings.' : id === 'zoho' ? 'Leads, notes and events — any Zoho data centre.' : 'Leads, activities and events.'}
                              </p>
                              <button type="button" disabled={!!crmBusy || !userId} onClick={() => connectCrm(id)} className={primaryButtonClass}>
                                {crmBusy === id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                                <span>Connect</span>
                              </button>
                            </Card>
                          ))}
                        </div>
                      )}
                      {crmNote && <Note tone={crmNote.ok ? 'success' : 'error'}>{crmNote.text}</Note>}
                    </SetupSection>
                  )}

                  {activeSubTab === 'compliance' && (
                    <SetupSection
                      title="Do not contact"
                      description="People on this list are never messaged or called — even if they're imported again as a new lead."
                      {...sectionProps('compliance')}
                    >
                      <Note>
                        Everyone who replies STOP, clicks unsubscribe, or asks the AI not to call again is added automatically.
                        Add your own suppression lists here too (for example a do-not-call list you've already been given).
                      </Note>
                      <Card title="Add numbers or email addresses">
                        <textarea
                          rows={4}
                          placeholder={'+971 50 123 4567\nname@company.com'}
                          value={dncInput}
                          onChange={(e) => setDncInput(e.target.value)}
                          className={`${inputClass} font-mono resize-y`}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={dncBusy || !dncInput.trim()}
                            onClick={async () => {
                              setDncBusy(true);
                              const r = await dncCall('do-not-contact-add', { values: dncInput });
                              setDncNote(r?.ok ? `Added ${r.added}${r.ignored ? ` · ${r.ignored} line${r.ignored === 1 ? '' : 's'} weren't a phone number or email` : ''}.` : r?.error || 'Could not add them.');
                              if (r?.ok) setDncInput('');
                              await loadDnc();
                              setDncBusy(false);
                            }}
                            className={primaryButtonClass}
                          >
                            {dncBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                            <span>Add to list</span>
                          </button>
                          <span className="text-[10px] text-ink-muted">One per line, or separated by commas.</span>
                        </div>
                        {dncNote && <p className="text-[11px] text-ink-muted">{dncNote}</p>}
                      </Card>
                      {dnc && dnc.entries.length > 0 && (
                        <Card title={`On your list${dnc.total > dnc.entries.length ? ` (latest ${dnc.entries.length} of ${dnc.total})` : ''}`}>
                          <ul className="divide-y divide-border max-h-64 overflow-y-auto -mx-1">
                            {dnc.entries.map((e) => (
                              <li key={e.id} className="flex items-center justify-between gap-2 px-1 py-1.5 text-xs">
                                <span className="font-mono text-ink-secondary truncate">{e.kind === 'phone' ? `+${e.value}` : e.value}</span>
                                <span className="flex items-center gap-2 shrink-0">
                                  <span className="text-[10px] text-ink-muted">{e.reason}</span>
                                  <button
                                    type="button"
                                    title="Remove — they can be contacted again"
                                    onClick={async () => {
                                      if (!window.confirm(`Remove ${e.value}? Campaigns will be able to contact them again.`)) return;
                                      const r = await dncCall('do-not-contact-remove', { id: e.id });
                                      if (r && !r.ok) setDncNote(r.error);
                                      await loadDnc();
                                    }}
                                    className="p-1 text-ink-muted hover:text-rose-400"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </Card>
                      )}
                    </SetupSection>
                  )}

                  {activeSubTab === 'notifications' && (
                    <SetupSection
                      title="Notifications"
                      description="Get a Slack message the moment the AI books a meeting."
                      {...sectionProps('notifications')}
                    >
                      <Card title="Slack">
                        <Field
                          label="Incoming webhook URL"
                          hint={
                            <>
                              Create one at{' '}
                              <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-ink-secondary underline">
                                api.slack.com/apps
                              </a>{' '}
                              → your app → Incoming Webhooks → Add New Webhook.
                            </>
                          }
                        >
                          <input
                            type="password"
                            placeholder="https://hooks.slack.com/services/…"
                            value={formData.slackWebhookUrl || ''}
                            onChange={(e) => setFormData({ ...formData, slackWebhookUrl: e.target.value })}
                            className={`${inputClass} font-mono`}
                          />
                        </Field>
                        <button type="button" onClick={handleTestSlack} disabled={testSlackStatus === 'sending'} className={secondaryButtonClass}>
                          {testSlackStatus === 'sending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Slack className="w-3.5 h-3.5" />}
                          <span>{testSlackStatus === 'sending' ? 'Sending…' : 'Send test notification'}</span>
                        </button>
                        {resultNote(testSlackStatus, testSlackResultMsg)}
                      </Card>
                    </SetupSection>
                  )}

                  {activeSubTab === 'integrations' && (
                    <SetupSection
                      title="Integrations"
                      description="Send every message, booking and lead update to your own automation."
                      {...sectionProps('integrations')}
                    >
                      <Card title="n8n / Zapier webhook">
                        <Field label="Webhook URL" hint="We POST a JSON payload here for each outreach message, booking and lead interaction.">
                          <input
                            type="url"
                            placeholder="https://n8n.yourcompany.com/webhook/outreach"
                            value={formData.n8nWebhookUrl || ''}
                            onChange={(e) => setFormData({ ...formData, n8nWebhookUrl: e.target.value })}
                            className={`${inputClass} font-mono`}
                          />
                        </Field>
                      </Card>
                    </SetupSection>
                  )}
                </div>

                <div className="shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-t border-border bg-canvas/60">
                  <span className="text-[11px] text-ink-muted hidden sm:block">Changes apply when you save.</span>
                  <div className="flex items-center gap-2 ml-auto">
                    <button type="button" onClick={onClose} className={secondaryButtonClass}>
                      Cancel
                    </button>
                    <button type="submit" className={primaryButtonClass}>
                      {savedSuccess ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Saved</span>
                        </>
                      ) : (
                        <span>Save Settings</span>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
