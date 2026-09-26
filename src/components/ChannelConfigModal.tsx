import React, { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X,
  Settings,
  MessageSquare,
  Mail,
  Network,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Shield,
  Zap,
  Send,
  Loader2,
  Bot,
  Calendar,
  ExternalLink,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { ChannelApiSettings, CampaignSettings, CalendarSlot } from '../types';
import { sendEmailDirectOrBackend } from '../services/emailService';
import { sendWhatsAppDirectOrBackend } from '../services/whatsappService';
import { resolveTemplateVariables } from '../utils/outreachEngine';
import { useGoogleCalendarConnection } from '../hooks/useGoogleCalendarConnection';
import { useChannelHealth } from '../hooks/useChannelHealth';
import { ChannelHealthPanel } from './ChannelHealthPanel';

interface ChannelConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: ChannelApiSettings;
  onSaveSettings: (settings: ChannelApiSettings) => void;
  campaignSettings?: CampaignSettings;
  availableSlots?: CalendarSlot[];
  userId?: string | null;
  accessToken?: string | null;
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
}) => {
  const [formData, setFormData] = useState<ChannelApiSettings>(settings);
  const [activeSubTab, setActiveSubTab] = useState<'whatsapp' | 'email' | 'bot' | 'n8n'>('email');
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
  const { health, loading: healthLoading, error: healthError, reload: reloadHealth } = useChannelHealth(accessToken);

  // Test email state
  const [testEmailTo, setTestEmailTo] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testResultMsg, setTestResultMsg] = useState('');

  // Test WhatsApp state
  const [testWaTo, setTestWaTo] = useState('');
  const [testWaStatus, setTestWaStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testWaResultMsg, setTestWaResultMsg] = useState('');

  // Collapsed by default — real testing value, but shouldn't clutter the default settings view.
  const [showEmailTest, setShowEmailTest] = useState(false);
  const [showWaTest, setShowWaTest] = useState(false);

  // WABA app-subscription state — a required Meta step with no dashboard UI of its own,
  // without which inbound replies never reach the webhook.
  const [subscribeStatus, setSubscribeStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [subscribeMsg, setSubscribeMsg] = useState('');

  // The shared Verify Token value orgs paste into their own Meta App's webhook config —
  // fetched once (it's not sensitive, but does live server-side as an env var).
  const [verifyToken, setVerifyToken] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    if (activeSubTab !== 'bot' || !accessToken || verifyToken !== null) return;
    fetch('/api/whatsapp/subscribe-app', { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((res) => res.json())
      .then((data) => setVerifyToken(data.verifyToken || ''))
      .catch(() => setVerifyToken(''));
  }, [activeSubTab, accessToken, verifyToken]);

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
    if (formData.whatsAppProvider === 'twilio' && (!formData.twilioAccountSid || !formData.twilioAuthToken)) {
      setTestWaStatus('error');
      setTestWaResultMsg('Please enter your Twilio Account SID and Auth Token first');
      return;
    }
    if (formData.whatsAppProvider === 'cloud_api' && (!formData.whatsappCloudApiKey || !formData.whatsappCloudPhoneId)) {
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
    if (!formData.whatsappCloudApiKey || !formData.whatsappBusinessAccountId) {
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
        body: JSON.stringify({
          accessToken: formData.whatsappCloudApiKey,
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

  type TemplateVarKey = 'whatsappTemplateVariables' | 'twilioContentVariables';

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
    if (formData.emailProvider === 'smtp') {
      if (!formData.smtpHost || !formData.smtpUser || !formData.smtpPass) {
        setTestStatus('error');
        setTestResultMsg('Please enter SMTP host, username, and password first');
        return;
      }
    } else if (formData.emailProvider === 'mailgun') {
      if (!formData.emailApiKey || !formData.mailgunDomain) {
        setTestStatus('error');
        setTestResultMsg('Please enter your Mailgun API key and domain first');
        return;
      }
    } else if (!formData.emailApiKey) {
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

  const testEmailBox = (
    <div className="pt-2 border-t border-border">
      <button
        type="button"
        onClick={() => setShowEmailTest((v) => !v)}
        className="w-full flex items-center justify-between text-[11px] font-semibold text-ink-muted hover:text-ink transition-colors"
      >
        <span>Test Live Email Delivery</span>
        {showEmailTest ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>

      {showEmailTest && (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <input
              type="email"
              placeholder="your-email@gmail.com"
              value={testEmailTo}
              onChange={(e) => setTestEmailTo(e.target.value)}
              className="flex-1 bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs"
            />
            <button
              type="button"
              onClick={handleSendTestEmail}
              disabled={testStatus === 'sending'}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-[#128C7E] hover:bg-[#0E6D62] disabled:opacity-50 transition-colors shadow-xs shrink-0"
            >
              {testStatus === 'sending' ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Sending...</span>
                </>
              ) : (
                <>
                  <Send className="w-3 h-3" />
                  <span>Send Live Test</span>
                </>
              )}
            </button>
          </div>

          {testStatus === 'success' && (
            <div className="mt-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>{testResultMsg}</span>
            </div>
          )}

          {testStatus === 'error' && (
            <div className="mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <span>{testResultMsg}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const testWhatsAppBox = (
    <div className="pt-2 border-t border-border">
      <button
        type="button"
        onClick={() => setShowWaTest((v) => !v)}
        className="w-full flex items-center justify-between text-[11px] font-semibold text-ink-muted hover:text-ink transition-colors"
      >
        <span>Test Live WhatsApp Delivery</span>
        {showWaTest ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>

      {showWaTest && (
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <input
              type="tel"
              placeholder="+971501234567"
              value={testWaTo}
              onChange={(e) => setTestWaTo(e.target.value)}
              className="flex-1 bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
            />
            <button
              type="button"
              onClick={handleSendTestWhatsApp}
              disabled={testWaStatus === 'sending'}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-[#128C7E] hover:bg-[#0E6D62] disabled:opacity-50 transition-colors shadow-xs shrink-0"
            >
              {testWaStatus === 'sending' ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Sending...</span>
                </>
              ) : (
                <>
                  <Send className="w-3 h-3" />
                  <span>Send Live Test</span>
                </>
              )}
            </button>
          </div>

          {testWaStatus === 'success' && (
            <div className="mt-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>{testWaResultMsg}</span>
            </div>
          )}

          {testWaStatus === 'error' && (
            <div className="mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <span>{testWaResultMsg}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="bg-surface/65 backdrop-blur-3xl border border-white/10 ring-1 ring-white/5 rounded-3xl shadow-modal max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden"
          >
        {/* Modal Header — pinned so the close button is always reachable, even when a
            provider panel below (e.g. WhatsApp Cloud API's template editor) grows tall. */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-canvas shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#25D366]/20 text-[#128C7E] flex items-center justify-center">
              <Zap className="w-4 h-4 fill-[#25D366]" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-ink">
                Automated Dispatch & API Configuration
              </h2>
              <p className="text-[11px] text-ink-muted">
                Configure real automated sending via Twilio WhatsApp, Resend Email, or Webhooks
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-ink-muted hover:text-ink rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sub Navigation */}
        <div className="flex border-b border-border px-6 bg-surface shrink-0">
          <button
            type="button"
            onClick={() => setActiveSubTab('whatsapp')}
            className={`py-3 px-3 text-xs font-semibold border-b-2 transition-all flex items-center gap-1.5 ${
              activeSubTab === 'whatsapp'
                ? 'border-[#25D366] text-emerald-300'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>WhatsApp Dispatch</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('email')}
            className={`py-3 px-3 text-xs font-semibold border-b-2 transition-all flex items-center gap-1.5 ${
              activeSubTab === 'email'
                ? 'border-[#4285F4] text-[#1967D2]'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
            <span>Email Dispatch</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('bot')}
            className={`py-3 px-3 text-xs font-semibold border-b-2 transition-all flex items-center gap-1.5 ${
              activeSubTab === 'bot'
                ? 'border-[#4285F4] text-[#1967D2]'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>AI Booking Bot</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('n8n')}
            className={`py-3 px-3 text-xs font-semibold border-b-2 transition-all flex items-center gap-1.5 ${
              activeSubTab === 'n8n'
                ? 'border-[#18181B] text-ink'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            <Network className="w-3.5 h-3.5" />
            <span>n8n / Webhook</span>
          </button>
        </div>

        {accessToken && (
          <div className="px-6 pt-4 shrink-0">
            <ChannelHealthPanel
              accessToken={accessToken}
              health={health}
              loading={healthLoading}
              error={healthError}
              onRefresh={reloadHealth}
            />
          </div>
        )}

        {/* Form Body — the only part that scrolls */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {activeSubTab === 'whatsapp' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-ink mb-1.5">
                  WhatsApp Dispatch Method
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setFormData({ ...formData, whatsAppProvider: 'cloud_api' })
                    }
                    className={`p-3 rounded-xl border text-left text-xs transition-all ${
                      formData.whatsAppProvider === 'cloud_api'
                        ? 'bg-[#128C7E]/10 border-[#25D366] text-emerald-300 font-semibold shadow-xs'
                        : 'bg-canvas border-border-strong text-ink-secondary'
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1">
                      <span>⚡ WhatsApp Cloud API (Meta)</span>
                      <span className="text-[9px] font-bold text-emerald-300 bg-emerald-500/15 px-1.5 py-0.5 rounded-full">Recommended</span>
                    </div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      Official Meta WhatsApp Business Platform. No middleman markup — direct from Meta.
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setFormData({ ...formData, whatsAppProvider: 'web_direct' })
                    }
                    className={`p-3 rounded-xl border text-left text-xs transition-all ${
                      formData.whatsAppProvider === 'web_direct'
                        ? 'bg-[#128C7E]/10 border-[#25D366] text-emerald-300 font-semibold shadow-xs'
                        : 'bg-canvas border-border-strong text-ink-secondary'
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1">
                      <span>WhatsApp Web / App</span>
                    </div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      Zero setup. Direct 1-click links opening your WhatsApp.
                    </div>
                  </button>
                </div>

                {!whatsappMoreOpen ? (
                  <button
                    type="button"
                    onClick={() => setWhatsappMoreOpen(true)}
                    className="mt-2 text-[11px] font-semibold text-[#1967D2] hover:underline"
                  >
                    More options (Twilio, Custom Webhook / BSP)
                  </button>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                    <button
                      type="button"
                      onClick={() =>
                        setFormData({ ...formData, whatsAppProvider: 'twilio' })
                      }
                      className={`p-3 rounded-xl border text-left text-xs transition-all ${
                        formData.whatsAppProvider === 'twilio'
                          ? 'bg-[#128C7E]/10 border-[#25D366] text-emerald-300 font-semibold shadow-xs'
                          : 'bg-canvas border-border-strong text-ink-secondary'
                      }`}
                    >
                      <div className="font-bold flex items-center gap-1">
                        <span>⚡ Twilio WhatsApp API</span>
                      </div>
                      <div className="text-[11px] text-ink-muted mt-0.5">
                        Automated background delivery via Twilio Sandbox or API.
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setFormData({ ...formData, whatsAppProvider: 'webhook' })
                      }
                      className={`p-3 rounded-xl border text-left text-xs transition-all ${
                        formData.whatsAppProvider === 'webhook'
                          ? 'bg-[#128C7E]/10 border-[#25D366] text-emerald-300 font-semibold shadow-xs'
                          : 'bg-canvas border-border-strong text-ink-secondary'
                      }`}
                    >
                      <div className="font-bold flex items-center gap-1">
                        <span>⚡ Custom Webhook / BSP</span>
                      </div>
                      <div className="text-[11px] text-ink-muted mt-0.5">
                        Route sends through your own n8n workflow or WhatsApp BSP (360dialog, Gupshup, etc.).
                      </div>
                    </button>
                  </div>
                )}
              </div>

              {formData.whatsAppProvider === 'twilio' && (
                <div className="space-y-3 p-4 bg-canvas rounded-xl border border-border">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-ink">Twilio WhatsApp Credentials</span>
                    <span className="text-[10px] text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                      Live Server Sending
                    </span>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                      Twilio Account SID
                    </label>
                    <input
                      type="text"
                      placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      value={formData.twilioAccountSid || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, twilioAccountSid: e.target.value })
                      }
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                      Twilio Auth Token
                    </label>
                    <input
                      type="password"
                      placeholder="••••••••••••••••••••••••••••••••"
                      value={formData.twilioAuthToken || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, twilioAuthToken: e.target.value })
                      }
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                      Twilio WhatsApp Sender Number (Optional)
                    </label>
                    <input
                      type="text"
                      placeholder="+14155238886 (Default Twilio Sandbox)"
                      value={formData.twilioFromNumber || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, twilioFromNumber: e.target.value })
                      }
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                    />
                    <p className="text-[10px] text-ink-muted mt-1">
                      💡 Tip: For free Twilio Sandbox testing, join the sandbox by sending the code to <code className="bg-surface-hover px-1 rounded">+1 415 523 8886</code> on WhatsApp.
                    </p>
                  </div>

                  <div className="pt-3 border-t border-border space-y-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-ink mb-1.5">
                        Message Mode
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, whatsappMessageMode: 'text' })}
                          className={`p-2 rounded-lg border text-[11px] font-medium transition-all ${
                            (formData.whatsappMessageMode || 'text') === 'text'
                              ? 'bg-[#128C7E]/10 border-[#25D366] text-emerald-300 font-semibold'
                              : 'bg-surface border-border-strong text-ink-secondary'
                          }`}
                        >
                          Free-form Text
                        </button>
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, whatsappMessageMode: 'template' })}
                          className={`p-2 rounded-lg border text-[11px] font-medium transition-all ${
                            formData.whatsappMessageMode === 'template'
                              ? 'bg-[#128C7E]/10 border-[#25D366] text-emerald-300 font-semibold'
                              : 'bg-surface border-border-strong text-ink-secondary'
                          }`}
                        >
                          Approved Template
                        </button>
                      </div>
                      <p className="text-[10px] text-ink-muted mt-1">
                        Free-form text only works within 24h of the recipient last messaging you. For <strong>cold outreach</strong> (first contact), you must use an approved template — otherwise sends will fail with a "re-engagement" error.
                      </p>
                    </div>

                    {formData.whatsappMessageMode === 'template' && (
                      <div className="space-y-3 p-3 bg-surface rounded-lg border border-border">
                        <div>
                          <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                            Twilio Content SID
                          </label>
                          <input
                            type="text"
                            placeholder="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                            value={formData.twilioContentSid || ''}
                            onChange={(e) => setFormData({ ...formData, twilioContentSid: e.target.value })}
                            className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                          />
                          <p className="text-[10px] text-ink-muted mt-1">
                            Create a WhatsApp Content Template in the{' '}
                            <a
                              href="https://console.twilio.com/us1/develop/sms/content-template-builder"
                              target="_blank"
                              rel="noreferrer"
                              className="text-[#1967D2] font-medium hover:underline"
                            >
                              Twilio Content Template Builder
                            </a>
                            , submit it for WhatsApp approval, then paste its Content SID (starts with "HX") here once approved.
                          </p>
                        </div>
                        {renderTemplateVariableEditor('twilioContentVariables')}
                      </div>
                    )}
                  </div>

                  {testWhatsAppBox}
                </div>
              )}

              {formData.whatsAppProvider === 'cloud_api' && (
                <div className="space-y-3 p-4 bg-canvas rounded-xl border border-border">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-ink">WhatsApp Cloud API Credentials</span>
                    <span className="text-[10px] text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                      Live Server Sending
                    </span>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                      Temporary or Permanent Access Token
                    </label>
                    <input
                      type="password"
                      placeholder="EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      value={formData.whatsappCloudApiKey || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, whatsappCloudApiKey: e.target.value })
                      }
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                      Phone Number ID
                    </label>
                    <input
                      type="text"
                      placeholder="1234567890123456"
                      value={formData.whatsappCloudPhoneId || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, whatsappCloudPhoneId: e.target.value })
                      }
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                    />
                  </div>

                  <p className="text-[10px] text-ink-muted leading-relaxed">
                    💡 Create a Meta app and WhatsApp Business Platform product at{' '}
                    <a
                      href="https://developers.facebook.com/apps"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#1967D2] font-medium hover:underline"
                    >
                      developers.facebook.com/apps
                    </a>
                    . The Access Token and Phone Number ID are shown on the WhatsApp → API Setup page.
                  </p>

                  <div className="p-2.5 bg-surface rounded-lg border border-border space-y-2">
                    <div>
                      <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                        WhatsApp Business Account ID
                      </label>
                      <input
                        type="text"
                        placeholder="shown right next to Phone Number ID on the same page"
                        value={formData.whatsappBusinessAccountId || ''}
                        onChange={(e) => setFormData({ ...formData, whatsappBusinessAccountId: e.target.value })}
                        className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                      />
                    </div>
                    <p className="text-[10px] text-ink-secondary leading-relaxed">
                      One more required step Meta doesn't surface in its dashboard: subscribe this app to your WhatsApp Business Account, or replies will never reach the AI booking bot.
                    </p>

                    <div className="pt-1.5 border-t border-border">
                      <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                        App Secret <span className="font-normal text-ink-muted">(recommended)</span>
                      </label>
                      <input
                        type="password"
                        placeholder="from Meta App Dashboard → Settings → Basic → App Secret"
                        value={formData.whatsappAppSecret || ''}
                        onChange={(e) => setFormData({ ...formData, whatsappAppSecret: e.target.value })}
                        className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                      />
                      <p className="text-[10px] text-ink-secondary mt-1 leading-relaxed">
                        Verifies inbound webhook calls really come from your Meta App — without it, anyone who finds this app's webhook URL could send forged messages pretending to be your customers.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleSubscribeApp}
                      disabled={subscribeStatus === 'loading'}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg text-white bg-[#1967D2] hover:bg-[#1554AE] disabled:opacity-50 transition-colors"
                    >
                      {subscribeStatus === 'loading' ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>Subscribing...</span>
                        </>
                      ) : (
                        <span>Subscribe App to WABA</span>
                      )}
                    </button>
                    {subscribeStatus === 'success' && (
                      <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span>{subscribeMsg}</span>
                      </div>
                    )}
                    {subscribeStatus === 'error' && (
                      <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                        <span>{subscribeMsg}</span>
                      </div>
                    )}
                  </div>

                  <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-[10px] text-amber-300 leading-relaxed space-y-1">
                    <p className="font-semibold text-amber-200">⚠️ "Sent" but nothing arrives on the phone? Meta's API accepting the request isn't the same as delivering it. Check:</p>
                    <ul className="list-disc list-inside space-y-0.5">
                      <li>The recipient number is added as a <strong>verified test recipient</strong> under your app's WhatsApp → API Setup page (test/dev apps can only message up to 5 verified numbers).</li>
                      <li>Your <strong>access token hasn't expired</strong> — the default temporary token from API Setup lasts only 24 hours; generate a permanent one via a System User for real use.</li>
                      <li>Meta isn't <strong>holding the message for quality assessment</strong> — brand-new test numbers/business accounts often have no quality rating yet, so Meta silently queues messages without delivering them. This app now detects that case and reports it as failed with an explanation, instead of a false "delivered."</li>
                      <li>You're inside the <strong>24-hour customer service window</strong> (the recipient messaged your number recently) — outside it, only pre-approved message templates can be delivered, not free-form text.</li>
                    </ul>
                  </div>

                  <div className="pt-3 border-t border-border space-y-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-ink mb-1.5">
                        Message Mode
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, whatsappMessageMode: 'text' })}
                          className={`p-2 rounded-lg border text-[11px] font-medium transition-all ${
                            (formData.whatsappMessageMode || 'text') === 'text'
                              ? 'bg-[#128C7E]/10 border-[#25D366] text-emerald-300 font-semibold'
                              : 'bg-surface border-border-strong text-ink-secondary'
                          }`}
                        >
                          Free-form Text
                        </button>
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, whatsappMessageMode: 'template' })}
                          className={`p-2 rounded-lg border text-[11px] font-medium transition-all ${
                            formData.whatsappMessageMode === 'template'
                              ? 'bg-[#128C7E]/10 border-[#25D366] text-emerald-300 font-semibold'
                              : 'bg-surface border-border-strong text-ink-secondary'
                          }`}
                        >
                          Approved Template
                        </button>
                      </div>
                      <p className="text-[10px] text-ink-muted mt-1">
                        Free-form text only works within 24h of the recipient last messaging you. For <strong>cold outreach</strong> (first contact), you must use an approved template — otherwise sends will fail with error 131047 ("re-engagement message").
                      </p>
                    </div>

                    {formData.whatsappMessageMode === 'template' && (
                      <div className="space-y-3 p-3 bg-surface rounded-lg border border-border">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                              Approved Template Name
                            </label>
                            <input
                              type="text"
                              placeholder="e.g. outreach_intro"
                              value={formData.whatsappTemplateName || ''}
                              onChange={(e) => setFormData({ ...formData, whatsappTemplateName: e.target.value })}
                              className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                              Language Code
                            </label>
                            <input
                              type="text"
                              placeholder="en_US"
                              value={formData.whatsappTemplateLanguage || ''}
                              onChange={(e) => setFormData({ ...formData, whatsappTemplateLanguage: e.target.value })}
                              className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                            />
                          </div>
                        </div>
                        <p className="text-[10px] text-ink-muted">
                          Create and submit a template for approval under WhatsApp Manager → Message Templates in{' '}
                          <a
                            href="https://business.facebook.com/wa/manage/message-templates/"
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#1967D2] font-medium hover:underline"
                          >
                            business.facebook.com/wa/manage/message-templates
                          </a>
                          . Use the exact template name and language code once approved (usually within minutes to a day).
                        </p>
                        {renderTemplateVariableEditor('whatsappTemplateVariables')}
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-border">
                    <label className="block text-[11px] font-semibold text-ink mb-1.5">
                      Safe Daily Send Limit
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={formData.safeDailyWhatsAppLimit ?? 250}
                      onChange={(e) =>
                        setFormData({ ...formData, safeDailyWhatsAppLimit: Math.max(1, parseInt(e.target.value, 10) || 1) })
                      }
                      className="w-full sm:w-40 bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                    />
                    <p className="text-[10px] text-ink-muted mt-1 leading-relaxed">
                      Meta caps unique conversations per 24h based on your number's messaging tier — new numbers
                      usually start at 250, scaling to 1,000 / 10,000+ as quality rating improves (check Meta
                      Business Manager → WhatsApp Manager → Phone Numbers). A batch larger than this is
                      automatically split across days instead of sent all at once, to protect your number.
                    </p>
                  </div>

                  {testWhatsAppBox}
                </div>
              )}

              {formData.whatsAppProvider === 'webhook' && (
                <div className="space-y-3 p-4 bg-canvas rounded-xl border border-border">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-ink">Custom Webhook / BSP</span>
                    <span className="text-[10px] text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                      Live Server Sending
                    </span>
                  </div>
                  <p className="text-[11px] text-ink-secondary leading-relaxed">
                    Each WhatsApp send will POST the lead and message text to the webhook URL configured under the <strong>n8n / Webhook</strong> tab. Point that at an n8n workflow (or any endpoint) that actually delivers the message through your BSP of choice — e.g. 360dialog, Gupshup, Infobip, or WATI — and returns a success status.
                  </p>
                  {!formData.n8nWebhookUrl && (
                    <div className="flex items-center gap-1.5 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>No webhook URL set yet — switch to the n8n / Webhook tab to add one.</span>
                    </div>
                  )}

                  {testWhatsAppBox}
                </div>
              )}
            </div>
          )}

          {activeSubTab === 'email' && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-[11px] text-emerald-300 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Email sending is automatic</span> — every campaign email
                  goes out through OmniReach's own delivery infrastructure. No setup needed here.
                </div>
              </div>

              {!emailAdvancedOpen ? (
                <button
                  type="button"
                  onClick={() => setEmailAdvancedOpen(true)}
                  className="text-[11px] font-semibold text-[#1967D2] hover:underline"
                >
                  Advanced: send from your own email account instead
                </button>
              ) : (
              <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-semibold text-ink">
                    Email Dispatch Method
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setEmailAdvancedOpen(false);
                      // 'resend' (not 'mailto_direct') is what actually triggers the
                      // automatic platform-sent path in sendEmailViaOrgProvider — this
                      // button was previously setting 'mailto_direct' instead, which is
                      // fully manual mailto: links, the opposite of "automatic".
                      setFormData({ ...formData, emailProvider: 'resend' });
                    }}
                    className="text-[11px] text-ink-muted hover:underline"
                  >
                    Use automatic sending instead
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setFormData({ ...formData, emailProvider: 'smtp' })
                    }
                    className={`p-3 rounded-xl border text-left text-xs transition-all ${
                      formData.emailProvider === 'smtp'
                        ? 'bg-[#4285F4]/10 border-[#4285F4] text-[#1967D2] font-semibold shadow-xs'
                        : 'bg-canvas border-border-strong text-ink-secondary'
                    }`}
                  >
                    <div className="font-bold">⚡ SMTP (Gmail, Zoho, Outlook...)</div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      Use any mailbox you already own — Gmail App Password, Zoho Mail, Office 365, or custom business email.
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setFormData({ ...formData, emailProvider: 'resend' })
                    }
                    className={`p-3 rounded-xl border text-left text-xs transition-all ${
                      formData.emailProvider === 'resend'
                        ? 'bg-[#4285F4]/10 border-[#4285F4] text-[#1967D2] font-semibold shadow-xs'
                        : 'bg-canvas border-border-strong text-ink-secondary'
                    }`}
                  >
                    <div className="font-bold">⚡ Resend API</div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      Automated background inbox delivery. Free 100/day.
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setFormData({ ...formData, emailProvider: 'sendgrid' })
                    }
                    className={`p-3 rounded-xl border text-left text-xs transition-all ${
                      formData.emailProvider === 'sendgrid'
                        ? 'bg-[#4285F4]/10 border-[#4285F4] text-[#1967D2] font-semibold shadow-xs'
                        : 'bg-canvas border-border-strong text-ink-secondary'
                    }`}
                  >
                    <div className="font-bold">⚡ SendGrid API</div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      Transactional high-volume delivery.
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setFormData({ ...formData, emailProvider: 'mailgun' })
                    }
                    className={`p-3 rounded-xl border text-left text-xs transition-all ${
                      formData.emailProvider === 'mailgun'
                        ? 'bg-[#4285F4]/10 border-[#4285F4] text-[#1967D2] font-semibold shadow-xs'
                        : 'bg-canvas border-border-strong text-ink-secondary'
                    }`}
                  >
                    <div className="font-bold">⚡ Mailgun API</div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      Pay-as-you-go transactional delivery, EU or US region.
                    </div>
                  </button>
                </div>
              </div>

              {formData.emailProvider === 'smtp' && (
                <div className="p-4 bg-canvas rounded-xl border border-border space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-ink">SMTP Credentials</span>
                    <span className="text-[10px] text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full border border-blue-500/20">
                      Live Server Sending
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                        SMTP Host
                      </label>
                      <input
                        type="text"
                        placeholder="smtp.gmail.com / smtp.zoho.com / smtp.office365.com"
                        value={formData.smtpHost || ''}
                        onChange={(e) => setFormData({ ...formData, smtpHost: e.target.value })}
                        className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                        Port
                      </label>
                      <input
                        type="number"
                        placeholder="587"
                        value={formData.smtpPort ?? ''}
                        onChange={(e) =>
                          setFormData({ ...formData, smtpPort: e.target.value ? Number(e.target.value) : undefined })
                        }
                        className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                      />
                    </div>

                    <div className="flex items-end pb-1.5">
                      <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary">
                        <input
                          type="checkbox"
                          checked={!!formData.smtpSecure}
                          onChange={(e) => setFormData({ ...formData, smtpSecure: e.target.checked })}
                          className="accent-[#4285F4]"
                        />
                        Use SSL (port 465)
                      </label>
                    </div>

                    <div className="sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                        Username
                      </label>
                      <input
                        type="text"
                        placeholder="you@gmail.com"
                        value={formData.smtpUser || ''}
                        onChange={(e) => setFormData({ ...formData, smtpUser: e.target.value })}
                        className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                        Password / App Password
                      </label>
                      <input
                        type="password"
                        placeholder="••••••••••••••••"
                        value={formData.smtpPass || ''}
                        onChange={(e) => setFormData({ ...formData, smtpPass: e.target.value })}
                        className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                        From Email (optional, defaults to Username)
                      </label>
                      <input
                        type="email"
                        placeholder="alex@yourbusiness.com"
                        value={formData.smtpFromEmail || ''}
                        onChange={(e) => setFormData({ ...formData, smtpFromEmail: e.target.value })}
                        className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                      />
                    </div>
                  </div>

                  <p className="text-[10px] text-ink-muted leading-relaxed">
                    💡 Gmail: you need an <strong>App Password</strong>, not your normal Gmail password (Gmail requires 2-Step Verification to be turned on first). Generate one at{' '}
                    <a
                      href="https://myaccount.google.com/apppasswords"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#1967D2] font-medium hover:underline"
                    >
                      myaccount.google.com/apppasswords
                    </a>{' '}
                    → name it (e.g. "OmniReach"), copy the 16-character password into the field above. Host <code className="bg-surface-hover px-1 rounded">smtp.gmail.com</code>, port <code className="bg-surface-hover px-1 rounded">587</code>.
                    <br />
                    💡 Zoho Mail: enable an app-specific password at{' '}
                    <a
                      href="https://accounts.zoho.com/home#security/app-password"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#1967D2] font-medium hover:underline"
                    >
                      accounts.zoho.com → Security → App Passwords
                    </a>
                    . Host <code className="bg-surface-hover px-1 rounded">smtp.zoho.com</code> (or <code className="bg-surface-hover px-1 rounded">smtp.zoho.eu</code> for EU accounts), port <code className="bg-surface-hover px-1 rounded">587</code>.
                    <br />
                    💡 Outlook/Office 365: host <code className="bg-surface-hover px-1 rounded">smtp.office365.com</code>, port <code className="bg-surface-hover px-1 rounded">587</code>. If your organization enforces MFA, generate an app password under Microsoft Account → Security instead of using your normal password.
                  </p>

                  {testEmailBox}
                </div>
              )}

              {(formData.emailProvider === 'resend' || formData.emailProvider === 'sendgrid' || formData.emailProvider === 'mailgun') && (
                <div className="p-4 bg-canvas rounded-xl border border-border space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-ink">
                      {formData.emailProvider === 'resend'
                        ? 'Resend API Key'
                        : formData.emailProvider === 'sendgrid'
                          ? 'SendGrid API Key'
                          : 'Mailgun API Key'}
                    </span>
                    <span className="text-[10px] text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full border border-blue-500/20">
                      Live Server Sending
                    </span>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                      API Key
                    </label>
                    <input
                      type="password"
                      placeholder={
                        formData.emailProvider === 'resend'
                          ? 're_1234567890abcdef...'
                          : formData.emailProvider === 'sendgrid'
                            ? 'SG.xxxxxxxxxxxxxxxx...'
                            : 'key-xxxxxxxxxxxxxxxx... or a Mailgun Private API key'
                      }
                      value={formData.emailApiKey || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, emailApiKey: e.target.value })
                      }
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                    />
                    <p className="text-[10px] text-ink-muted mt-1">
                      {formData.emailProvider === 'resend'
                        ? '💡 Free tier: Grab an API key from resend.com to send automated emails directly to inboxes.'
                        : formData.emailProvider === 'sendgrid'
                          ? '💡 Obtain your API key from app.sendgrid.com with Mail Send permissions.'
                          : '💡 Obtain your Private API key from app.mailgun.com → Settings → API Keys.'}
                    </p>
                  </div>

                  {formData.emailProvider === 'mailgun' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      <div>
                        <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                          Sending Domain
                        </label>
                        <input
                          type="text"
                          placeholder="mg.yourdomain.com"
                          value={formData.mailgunDomain || ''}
                          onChange={(e) => setFormData({ ...formData, mailgunDomain: e.target.value })}
                          className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-ink-muted mb-1">
                          Region
                        </label>
                        <select
                          value={formData.mailgunRegion || 'us'}
                          onChange={(e) =>
                            setFormData({ ...formData, mailgunRegion: e.target.value as 'us' | 'eu' })
                          }
                          className="w-full bg-surface border border-border-strong rounded-lg px-3 py-1.5 text-xs"
                        >
                          <option value="us">US</option>
                          <option value="eu">EU</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {testEmailBox}
                </div>
              )}
              </div>
              )}
            </div>
          )}

          {activeSubTab === 'bot' && (
            <div className="space-y-4">
              <div className="p-4 bg-canvas rounded-xl border border-border space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-ink">Google Calendar Connection</span>
                  {googleCalendar.status.connected && (
                    <span className="text-[10px] text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Connected
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-ink-muted leading-relaxed">
                  When a WhatsApp prospect confirms a meeting time with the AI booking bot, it creates a real event with a
                  Google Meet link on this calendar. Requires WhatsApp Cloud API to be configured above (the bot replies via
                  the same phone number).
                </p>

                {!userId ? (
                  <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                    Sign in to a workspace to connect Google Calendar for the AI booking bot.
                  </p>
                ) : googleCalendar.status.connected ? (
                  <div className="flex items-center justify-between p-2.5 bg-surface rounded-lg border border-border">
                    <span className="text-xs text-ink-secondary">{googleCalendar.status.connectedEmail || 'Connected'}</span>
                    <button
                      type="button"
                      onClick={googleCalendar.connect}
                      className="text-[11px] text-ink-muted hover:text-ink underline"
                    >
                      Reconnect
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={googleCalendar.connect}
                    disabled={googleCalendar.connecting}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl text-white bg-[#4285F4] hover:bg-[#3367D6] shadow-sm transition-all disabled:opacity-60"
                  >
                    <Calendar className="w-3.5 h-3.5" />
                    {googleCalendar.connecting ? 'Redirecting to Google…' : 'Connect Google Calendar'}
                    <ExternalLink className="w-3 h-3" />
                  </button>
                )}

                {googleCalendar.error && (
                  <p className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                    {googleCalendar.error}
                  </p>
                )}
              </div>

              <div className="p-4 bg-canvas rounded-xl border border-border space-y-3">
                <span className="text-xs font-bold text-ink">WhatsApp Webhook (one-time Meta setup)</span>
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  Four steps, done once when you connect a new WhatsApp number:
                </p>

                <div className="space-y-2">
                  <div>
                    <label className="block text-[10px] font-semibold text-ink-muted mb-1">
                      1. Callback URL — paste into Meta App → WhatsApp → Configuration → Webhook
                    </label>
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 bg-surface px-2 py-1.5 rounded-lg border border-border text-[10px] truncate">
                        {typeof window !== 'undefined' ? window.location.origin : ''}/api/whatsapp/webhook
                      </code>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(`${typeof window !== 'undefined' ? window.location.origin : ''}/api/whatsapp/webhook`, 'url')
                        }
                        className="p-1.5 rounded-lg border border-border bg-surface text-ink-secondary hover:text-ink shrink-0"
                        title="Copy"
                      >
                        {copiedField === 'url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-ink-muted mb-1">
                      2. Verify Token — same field, right below the Callback URL
                    </label>
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 bg-surface px-2 py-1.5 rounded-lg border border-border text-[10px] truncate">
                        {verifyToken === null ? 'Loading…' : verifyToken || 'Not configured yet'}
                      </code>
                      <button
                        type="button"
                        onClick={() => verifyToken && copyToClipboard(verifyToken, 'token')}
                        disabled={!verifyToken}
                        className="p-1.5 rounded-lg border border-border bg-surface text-ink-secondary hover:text-ink shrink-0 disabled:opacity-40"
                        title="Copy"
                      >
                        {copiedField === 'token' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>

                <p className="text-[11px] text-ink-muted leading-relaxed">
                  3. Subscribe to the <strong>messages</strong> field, right below where you pasted those two values.
                  <br />
                  4. Back on the <strong>WhatsApp Dispatch</strong> tab, click <strong>Subscribe App to WABA</strong> — the one Meta step with no dashboard UI of its own.
                </p>
              </div>
            </div>
          )}

          {activeSubTab === 'n8n' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">
                  Live n8n / Webhook URL (Optional)
                </label>
                <input
                  type="url"
                  placeholder="https://n8n.yourdomain.com/webhook/outreach-trigger"
                  value={formData.n8nWebhookUrl || ''}
                  onChange={(e) =>
                    setFormData({ ...formData, n8nWebhookUrl: e.target.value })
                  }
                  className="w-full bg-canvas border border-border-strong rounded-lg px-3 py-2 text-xs text-ink font-mono"
                />
                <p className="text-[11px] text-ink-muted mt-1.5 leading-relaxed">
                  When configured, every automated batch message, calendar booking, and lead interaction will automatically post an HTTP payload to your n8n workflow or Zapier webhook.
                </p>
              </div>
            </div>
          )}

          {/* Footer Buttons */}
          <div className="flex items-center justify-end gap-2 pt-4 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-medium text-ink-muted hover:bg-canvas rounded-xl border border-border-strong transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold rounded-xl text-white bg-brand-strong hover:bg-[#0d6e62] shadow-sm transition-all"
            >
              {savedSuccess ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#25D366]" />
                  <span>Settings Saved!</span>
                </>
              ) : (
                <span>Save Channel Settings</span>
              )}
            </button>
          </div>
        </form>
      </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
