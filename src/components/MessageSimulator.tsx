import React, { useState, useEffect } from 'react';
import {
  MessageSquare,
  Mail,
  Send,
  Sparkles,
  Calendar,
  ExternalLink,
  CheckCircle2,
  Clock,
  User,
  Phone,
  Building,
  RefreshCw,
  Copy,
  Check,
  Zap,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Lead, CalendarSlot, CampaignSettings, MessageTemplate, ChatMessage, ChannelApiSettings } from '../types';
import {
  generateAIPersonalizedMessage,
  generateAIAutoReply,
  generateWhatsAppLink,
  generateMailtoLink,
  interpolateTemplate,
} from '../utils/outreachEngine';
import { sendEmailDirectOrBackend } from '../services/emailService';

interface MessageSimulatorProps {
  leads: Lead[];
  selectedLeadId: string;
  onSelectLead: (leadId: string) => void;
  availableSlots: CalendarSlot[];
  campaignSettings: CampaignSettings;
  channelSettings?: ChannelApiSettings;
  templates: MessageTemplate[];
  accessToken?: string | null;
  onUpdateLead: (lead: Lead) => void;
  onUpdateSettings?: (settings: CampaignSettings) => void;
  onBookCalendarSlot: (slotId: string, lead: Lead, notes: string) => void;
}

export const MessageSimulator: React.FC<MessageSimulatorProps> = ({
  leads,
  selectedLeadId,
  onSelectLead,
  availableSlots,
  campaignSettings,
  channelSettings,
  templates,
  accessToken,
  onUpdateLead,
  onUpdateSettings,
  onBookCalendarSlot,
}) => {
  const [activeChannel, setActiveChannel] = useState<'whatsapp' | 'email'>('whatsapp');
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isSendingLiveEmail, setIsSendingLiveEmail] = useState(false);
  const [sendResultStatus, setSendResultStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [sendResultMessage, setSendResultMessage] = useState('');

  // Active Lead
  const lead = leads.find((l) => l.id === selectedLeadId) || leads[0];

  // Generated Messages State
  const [whatsAppText, setWhatsAppText] = useState<string>('');
  const [emailSubject, setEmailSubject] = useState<string>('');
  const [emailBody, setEmailBody] = useState<string>('');

  // Interactive WhatsApp Chat History
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [customReplyInput, setCustomReplyInput] = useState<string>('');
  const [isAiReplying, setIsAiReplying] = useState(false);

  // Selected template
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(templates[0]?.id || 'tpl-1');
  const [showTestTools, setShowTestTools] = useState(false);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || templates[0];

  // Generate copy whenever selected lead changes
  useEffect(() => {
    if (!lead) return;

    let isMounted = true;
    const generateCopy = async () => {
      setIsGenerating(true);
      const res = campaignSettings.useAiCopywriting
        ? await generateAIPersonalizedMessage(lead, campaignSettings, selectedTemplate, availableSlots, accessToken)
        : {
            whatsApp: interpolateTemplate(selectedTemplate?.whatsAppContent || '', lead, campaignSettings, availableSlots),
            emailSubject: interpolateTemplate(selectedTemplate?.emailSubject || '', lead, campaignSettings, availableSlots),
            emailBody: interpolateTemplate(selectedTemplate?.emailBody || '', lead, campaignSettings, availableSlots),
          };

      if (isMounted) {
        setWhatsAppText(res.whatsApp);
        setEmailSubject(res.emailSubject);
        setEmailBody(res.emailBody);

        // Initialize Chat History
        setChatMessages([
          {
            id: `msg-1`,
            sender: 'ai_agent',
            channel: 'whatsapp',
            content: res.whatsApp,
            timestamp: 'Just now',
            status: 'read',
          },
        ]);
        setIsGenerating(false);
      }
    };

    generateCopy();

    return () => {
      isMounted = false;
    };
  }, [lead?.id, selectedTemplateId, campaignSettings.useAiCopywriting]);

  // Handle client reply simulation
  const handleClientReply = async (replyText: string) => {
    if (!lead || !replyText.trim()) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: 'client',
      channel: 'whatsapp',
      content: replyText,
      timestamp: 'Just now',
    };

    setChatMessages((prev) => [...prev, userMsg]);
    setCustomReplyInput('');
    setIsAiReplying(true);

    // AI Auto-Reply
    const aiResponse = await generateAIAutoReply(
      replyText,
      lead,
      campaignSettings,
      availableSlots,
      accessToken
    );

    setIsAiReplying(false);
    const agentMsg: ChatMessage = {
      id: `agent-${Date.now()}`,
      sender: 'ai_agent',
      channel: 'whatsapp',
      content: aiResponse,
      timestamp: 'Just now',
      status: 'read',
    };

    setChatMessages((prev) => [...prev, agentMsg]);

    // Check if meeting should be scheduled
    const lower = replyText.toLowerCase();
    if (lower.includes('thursday') || lower.includes('friday') || lower.includes('yes') || lower.includes('book') || lower.includes('confirm')) {
      const openSlot = availableSlots.find((s) => s.available);
      if (openSlot) {
        onBookCalendarSlot(openSlot.id, lead, 'Booked via interactive WhatsApp outreach simulator');
        onUpdateLead({
          ...lead,
          status: 'Meeting Scheduled',
          whatsAppStatus: 'Replied',
          meetingDate: openSlot.date,
          meetingTime: openSlot.time,
        });
      }
    } else {
      onUpdateLead({
        ...lead,
        status: 'Interested',
        whatsAppStatus: 'Replied',
      });
    }
  };

  const handleSendLiveEmailNow = async () => {
    if (!lead || !lead.email) return;
    setIsSendingLiveEmail(true);
    setSendResultStatus('idle');
    setSendResultMessage('');

    try {
      // Leave this undefined when there's no real address to prefer — sendEmailViaOrgProvider
      // (lib/emailSender.ts) already picks the correct platform address itself via
      // RESEND_FROM_ADDRESS (the org's verified domain); hardcoding the sandbox address here
      // used to short-circuit that and force it even when a verified domain was configured.
      const resolvedSenderEmail =
        channelSettings?.smtpFromEmail ||
        (campaignSettings.senderEmail && !campaignSettings.senderEmail.includes('.example')
          ? campaignSettings.senderEmail
          : undefined);

      const res = await sendEmailDirectOrBackend({
        lead,
        subject: emailSubject,
        body: emailBody,
        channelSettings: channelSettings || { emailProvider: 'resend' },
        senderName: campaignSettings.senderName,
        senderEmail: resolvedSenderEmail,
        // Without this, the server can't resolve which org this send belongs to, so it
        // skips seeding the reply-tracking conversation — a reply to a test email sent
        // from here would never reach the AI booking bot, unlike a real campaign send.
        accessToken,
      });

      if (res.delivered) {
        setSendResultStatus('success');
        setSendResultMessage(`Email successfully dispatched to ${lead.email}! Check inbox.`);
        onUpdateLead({
          ...lead,
          emailStatus: 'Sent',
          lastContacted: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
      } else {
        setSendResultStatus('error');
        setSendResultMessage(res.errorDetail || 'Failed to dispatch email. Check API key in settings.');
      }
    } catch (err: any) {
      setSendResultStatus('error');
      setSendResultMessage(err.message || 'Delivery error');
    } finally {
      setIsSendingLiveEmail(false);
    }
  };

  const handleCopyText = (textToCopy: string) => {
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const nextSlot = availableSlots.find((s) => s.available) || availableSlots[0];

  if (!lead) {
    return (
      <div className="bg-white rounded-2xl border border-[#E4E4E7] p-10 text-center">
        <div className="w-12 h-12 rounded-full bg-[#FAFAFA] border border-[#D4D4D8] flex items-center justify-center mx-auto text-[#71717A] mb-3">
          <MessageSquare className="w-5 h-5" />
        </div>
        <h3 className="text-sm font-bold text-[#18181B]">No Leads Yet</h3>
        <p className="text-xs text-[#71717A] max-w-sm mx-auto mt-1">
          Import a spreadsheet of contacts first — then come back here to preview and test personalized WhatsApp & Email messages.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header Card & Lead Selector */}
      <div className="bg-white rounded-2xl border border-[#E4E4E7] p-5 shadow-card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-[#18181B]">
                Interactive Message & Conversation Simulator
              </h1>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-[#128C7E]/10 text-[#128C7E] border border-[#128C7E]/30">
                Live Preview
              </span>
            </div>
            <p className="text-xs text-[#71717A] mt-0.5">
              Preview AI-generated WhatsApp messages and cold outreach emails with variable interpolation and test real-time simulated client replies.
            </p>
          </div>

          {/* Lead Selector Dropdown */}
          <div className="flex items-center gap-3">
            <div className="w-full sm:w-64">
              <label className="block text-[11px] font-semibold text-[#71717A] mb-1 uppercase tracking-wider">
                Select Spreadsheet Contact
              </label>
              <select
                id="simulator-lead-select"
                value={selectedLeadId}
                onChange={(e) => onSelectLead(e.target.value)}
                className="w-full bg-[#FAFAFA] border border-[#D4D4D8] rounded-lg px-3 py-1.5 text-xs font-semibold text-[#18181B] focus:ring-1 focus:ring-[#25D366]"
              >
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.company})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Selected Lead Metadata Strip */}
        {lead && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-[#F4F4F5] text-xs">
            <div className="flex items-center gap-2">
              <User className="w-3.5 h-3.5 text-[#71717A]" />
              <span className="text-[#18181B] font-medium">{lead.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <Building className="w-3.5 h-3.5 text-[#71717A]" />
              <span className="text-[#18181B] font-medium">{lead.company}</span>
            </div>
            <div className="flex items-center gap-2">
              <Phone className="w-3.5 h-3.5 text-[#25D366]" />
              <span className="font-mono text-[#18181B]">{lead.phone}</span>
            </div>
            <div className="flex items-center gap-2">
              <Mail className="w-3.5 h-3.5 text-[#4285F4]" />
              <span className="text-[#18181B] truncate">{lead.email}</span>
            </div>
          </div>
        )}
      </div>

      {/* Channel Switcher Tabs */}
      <div className="flex items-center justify-between border-b border-[#E4E4E7] pb-2">
        <div className="flex items-center gap-2">
          <button
            id="tab-sim-whatsapp"
            onClick={() => setActiveChannel('whatsapp')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeChannel === 'whatsapp'
                ? 'bg-[#25D366] text-white shadow-xs'
                : 'bg-white text-[#71717A] hover:text-[#18181B] border border-[#D4D4D8]'
            }`}
          >
            <MessageSquare className="w-4 h-4" />
            <span>WhatsApp Smartphone Simulator</span>
          </button>

          <button
            id="tab-sim-email"
            onClick={() => setActiveChannel('email')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeChannel === 'email'
                ? 'bg-[#4285F4] text-white shadow-xs'
                : 'bg-white text-[#71717A] hover:text-[#18181B] border border-[#D4D4D8]'
            }`}
          >
            <Mail className="w-4 h-4" />
            <span>Email Client Preview</span>
          </button>
        </div>

        {/* Template Selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#71717A] hidden sm:inline">Template:</span>
          <select
            value={selectedTemplateId}
            onChange={(e) => setSelectedTemplateId(e.target.value)}
            className="bg-white border border-[#D4D4D8] rounded-lg px-2.5 py-1 text-xs text-[#18181B]"
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            id="simulator-toggle-ai-copywriting"
            type="button"
            onClick={() =>
              onUpdateSettings?.({
                ...campaignSettings,
                useAiCopywriting: !campaignSettings.useAiCopywriting,
              })
            }
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
              campaignSettings.useAiCopywriting
                ? 'bg-[#128C7E]/10 border-[#128C7E]/30 text-[#0F6D42]'
                : 'bg-[#FAFAFA] border-[#D4D4D8] text-[#3F3F46]'
            }`}
            title="When off, your template text is sent exactly as written (with {{variables}} filled in) — no AI rewrite."
          >
            <Sparkles className="w-3 h-3" />
            <span>{campaignSettings.useAiCopywriting ? 'AI Copywriting: On' : 'AI Copywriting: Off'}</span>
          </button>
        </div>
      </div>

      {/* MAIN VIEW: WhatsApp vs Email */}
      {activeChannel === 'whatsapp' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: WhatsApp Mobile Mockup */}
          <div className="lg:col-span-7 flex justify-center">
            <div className="w-full max-w-md bg-[#ECE5DD] rounded-3xl border-4 border-[#18181B] shadow-modal overflow-hidden flex flex-col h-[560px]">
              {/* WhatsApp Header Bar */}
              <div className="bg-[#075E54] text-white px-4 py-3 flex items-center justify-between shadow-md">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-[#128C7E] flex items-center justify-center font-bold text-white text-xs border border-white/30">
                    {lead.name.charAt(0)}
                  </div>
                  <div>
                    <div className="font-semibold text-xs flex items-center gap-1.5">
                      <span>{lead.name}</span>
                      <span className="text-[10px] text-emerald-200">({lead.company})</span>
                    </div>
                    <div className="text-[10px] text-emerald-100 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#25D366]"></span>
                      <span>Online • {lead.phone}</span>
                    </div>
                  </div>
                </div>
                <a
                  href={generateWhatsAppLink(lead.phone, whatsAppText)}
                  target="_blank"
                  rel="noreferrer"
                  className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                  title="Open in WhatsApp Web"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>

              {/* Chat Message Scroll Area */}
              <div className="flex-1 p-4 overflow-y-auto space-y-3 no-scrollbar">
                <div className="text-center">
                  <span className="text-[10px] bg-white/70 text-[#3F3F46] px-2.5 py-0.5 rounded-full font-medium shadow-xs">
                    Today
                  </span>
                </div>

                {chatMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.sender === 'ai_agent' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl p-3 text-xs shadow-xs space-y-1 ${
                        msg.sender === 'ai_agent'
                          ? 'bg-[#DCF8C6] text-[#075E54] rounded-tr-xs'
                          : 'bg-white text-[#18181B] rounded-tl-xs'
                      }`}
                    >
                      <div className="whitespace-pre-line leading-relaxed font-sans">{msg.content}</div>
                      <div className="flex items-center justify-end gap-1 text-[10px] text-[#71717A]">
                        <span>{msg.timestamp}</span>
                        {msg.sender === 'ai_agent' && (
                          <span className="text-[#34B7F1] font-bold">✓✓</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {isAiReplying && (
                  <div className="flex justify-end">
                    <div className="bg-[#DCF8C6] text-[#075E54] rounded-2xl rounded-tr-xs px-3 py-2 text-xs flex items-center gap-2">
                      <Sparkles className="w-3.5 h-3.5 animate-spin text-[#128C7E]" />
                      <span>AI formatting smart reply...</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Chat Input & Direct Send */}
              <div className="p-2.5 bg-[#F0F0F0] border-t border-[#D4D4D8] flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Type simulated prospect reply..."
                  value={customReplyInput}
                  onChange={(e) => setCustomReplyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleClientReply(customReplyInput);
                  }}
                  className="flex-1 bg-white border border-[#D4D4D8] rounded-full px-4 py-2 text-xs text-[#18181B] focus:outline-none focus:ring-1 focus:ring-[#25D366]"
                />
                <button
                  onClick={() => handleClientReply(customReplyInput)}
                  disabled={!customReplyInput.trim()}
                  className="w-8 h-8 rounded-full bg-[#128C7E] text-white flex items-center justify-center hover:bg-[#075E54] transition-all disabled:opacity-40"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Right: Quick Simulated Reply Triggers & One-Click Actions */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-white rounded-2xl border border-[#E4E4E7] p-5 shadow-card space-y-4">
              <button
                type="button"
                onClick={() => setShowTestTools((v) => !v)}
                className="w-full flex items-center justify-between text-xs font-bold uppercase tracking-wider text-[#71717A] hover:text-ink transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-[#25D366]" />
                  Test Tools
                </span>
                {showTestTools ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>

              {showTestTools && (
                <>
                  <p className="text-xs text-[#71717A]">
                    Click any simulated response to test how the AI Auto-Reply handles objections, answers pricing queries, or books meetings:
                  </p>

                  <div className="space-y-2">
                    <button
                      onClick={() =>
                        handleClientReply(`Yes, I'm interested! Can we do Thursday at 10:00 AM?`)
                      }
                      className="w-full text-left p-3 rounded-xl bg-[#FAFAFA] hover:bg-[#128C7E]/10 hover:border-[#128C7E]/30 border border-[#E4E4E7] text-xs font-medium text-[#18181B] transition-all"
                    >
                      <span className="font-semibold text-[#128C7E]">🟢 "Yes! Let's book Thursday 10:00 AM"</span>
                      <div className="text-[11px] text-[#71717A] mt-0.5">Triggers calendar confirmation & Google Meet booking</div>
                    </button>

                    <button
                      onClick={() =>
                        handleClientReply(`What are your pricing plans and does it connect with Google Sheets?`)
                      }
                      className="w-full text-left p-3 rounded-xl bg-[#FAFAFA] hover:bg-[#128C7E]/10 hover:border-[#128C7E]/30 border border-[#E4E4E7] text-xs font-medium text-[#18181B] transition-all"
                    >
                      <span className="font-semibold text-[#18181B]">💬 "What are your pricing plans & features?"</span>
                      <div className="text-[11px] text-[#71717A] mt-0.5">Tests AI product pitch and meeting invitation</div>
                    </button>

                    <button
                      onClick={() =>
                        handleClientReply(`Please remove me from your list, not interested right now.`)
                      }
                      className="w-full text-left p-3 rounded-xl bg-[#FAFAFA] hover:bg-[#FEF2F2] hover:border-[#FECACA] border border-[#E4E4E7] text-xs font-medium text-[#18181B] transition-all"
                    >
                      <span className="font-semibold text-[#DC2626]">🛑 "Not interested / Opt out"</span>
                      <div className="text-[11px] text-[#71717A] mt-0.5">Tests polite AI opt-out acknowledgment</div>
                    </button>
                  </div>
                </>
              )}

              {/* Direct Actions */}
              <div className="pt-4 border-t border-[#F4F4F5] space-y-2">
                <a
                  href={generateWhatsAppLink(lead.phone, whatsAppText)}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#25D366] text-white font-semibold text-xs shadow-sm hover:bg-[#25D366] transition-all"
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>Open & Send via WhatsApp Web</span>
                </a>

                <button
                  onClick={() => handleCopyText(whatsAppText)}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-[#FAFAFA] text-[#3F3F46] font-medium text-xs hover:bg-[#F4F4F5] border border-[#D4D4D8] transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-[#25D366]" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? 'Copied to Clipboard!' : 'Copy WhatsApp Text'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Email Client Simulator */
        <div className="bg-white rounded-2xl border border-[#E4E4E7] shadow-card overflow-hidden">
          {/* Email Top Bar */}
          <div className="bg-[#FAFAFA] border-b border-[#E4E4E7] px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-[#3F3F46]">
              <Mail className="w-4 h-4 text-[#4285F4]" />
              <span className="font-semibold text-[#18181B]">Email Inbox Preview</span>
              <span>•</span>
              <span>To: {lead.email}</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSendLiveEmailNow}
                disabled={isSendingLiveEmail || !lead.email}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#128C7E] text-white text-xs font-semibold shadow-xs hover:bg-[#0E6D62] disabled:opacity-50 transition-colors"
                title="Dispatch directly to lead's inbox via Resend"
              >
                {isSendingLiveEmail ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Dispatching...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>Send Live to Inbox</span>
                  </>
                )}
              </button>

              <a
                href={generateMailtoLink(lead.email, emailSubject, emailBody)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FAFAFA] text-[#3F3F46] border border-[#D4D4D8] text-xs font-semibold shadow-xs hover:bg-[#F4F4F5]"
              >
                <ExternalLink className="w-3.5 h-3.5 text-[#71717A]" />
                <span>Mail Client</span>
              </a>
              <button
                onClick={() => handleCopyText(`Subject: ${emailSubject}\n\n${emailBody}`)}
                className="p-1.5 text-[#71717A] hover:text-[#18181B] hover:bg-[#FAFAFA] rounded-lg border border-[#D4D4D8]"
                title="Copy Full Email"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-[#25D366]" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Live Dispatch Notification Alert */}
          {sendResultStatus === 'success' && (
            <div className="bg-emerald-50 border-b border-emerald-200 px-6 py-2 text-emerald-800 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{sendResultMessage}</span>
            </div>
          )}

          {sendResultStatus === 'error' && (
            <div className="bg-red-50 border-b border-red-200 px-6 py-2 text-red-700 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <span>{sendResultMessage}</span>
            </div>
          )}

          {/* Email Body & Details */}
          <div className="p-6 space-y-5">
            {/* Subject Line */}
            <div className="pb-3 border-b border-[#F4F4F5]">
              <span className="text-[11px] font-semibold text-[#71717A] uppercase tracking-wider block mb-1">
                Subject Line
              </span>
              <h2 className="text-base font-bold text-[#18181B]">{emailSubject}</h2>
            </div>

            {/* Sender & Recipient Header */}
            <div className="flex items-center justify-between text-xs text-[#71717A]">
              <div>
                <span className="font-semibold text-[#18181B]">
                  {campaignSettings.senderName} ({campaignSettings.senderEmail})
                </span>
                <div className="text-[11px]">to {lead.name} &lt;{lead.email}&gt;</div>
              </div>
              <span className="text-[11px]">Today, 10:30 AM</span>
            </div>

            {/* Email Message Content */}
            <div className="bg-[#FAFAFA] p-5 rounded-xl border border-[#E4E4E7] text-xs text-[#18181B] whitespace-pre-line leading-relaxed font-sans">
              {emailBody}
            </div>

            {/* Embedded Google Calendar Card */}
            {nextSlot && (
              <div className="p-4 bg-[#4285F4]/10 border border-[#4285F4]/10 rounded-xl flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-[#4285F4] text-white flex items-center justify-center font-bold">
                    <Calendar className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-semibold text-[#1967D2]">
                      Quick Call with {campaignSettings.senderName}
                    </div>
                    <div className="text-[11px] text-[#3F3F46]">
                      Next Available Slot: {nextSlot.date} at {nextSlot.time} (Google Meet)
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => {
                    onBookCalendarSlot(nextSlot.id, lead, 'Booked via simulated Email link');
                    onUpdateLead({
                      ...lead,
                      status: 'Meeting Scheduled',
                      emailStatus: 'Clicked',
                      meetingDate: nextSlot.date,
                      meetingTime: nextSlot.time,
                    });
                  }}
                  className="px-3.5 py-1.5 rounded-lg bg-[#1967D2] text-white text-xs font-semibold hover:bg-[#1558B0] shadow-xs"
                >
                  Confirm Slot
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
