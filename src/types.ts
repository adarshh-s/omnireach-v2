export type LeadStatus =
  | 'Pending'
  | 'In Progress'
  | 'Contacted'
  | 'Interested'
  | 'Meeting Scheduled'
  | 'Not Interested'
  | 'Replied'
  | 'Do Not Contact'
  | 'Failed';

export type ChannelDeliveryStatus =
  | 'Pending'
  | 'Queued'
  | 'Sending'
  | 'Sent'
  | 'Delivered'
  | 'Read'
  | 'Opened'
  | 'Clicked'
  | 'Replied'
  | 'Failed'
  /** Email only: the address doesn't exist — it's on the do-not-contact list (lib/emailBounces.ts). */
  | 'Bounced'
  | 'Skipped'
  | 'Cancelled';

export interface Lead {
  id: string;
  name: string;
  company: string;
  phone: string;
  rawPhone?: string;
  email: string;
  country?: string;
  status: LeadStatus;
  whatsAppStatus: ChannelDeliveryStatus;
  emailStatus: ChannelDeliveryStatus;
  /** Undefined is treated the same as 'Pending' — not backfilled on existing leads/DB rows. */
  voiceCallStatus?: ChannelDeliveryStatus;
  whatsAppMessage?: string;
  emailSubject?: string;
  emailBody?: string;
  meetingDate?: string;
  meetingTime?: string;
  notes?: string;
  tags?: string[];
  /** YYYY-MM-DD — a manual reminder date, unrelated to AI-booked meetings. */
  followUpDate?: string;
  lastContacted?: string;
  channelUsed?: 'omnichannel' | 'whatsapp' | 'email' | 'voice' | 'none';
  isValidPhone: boolean;
  isValidEmail: boolean;
  customFields?: Record<string, string>;
  optedOut?: boolean;
  /** The lead agreed to be called (prior express written consent). Required before AI calls
   * to US numbers (TCPA) — see lib/regionRules.ts. */
  callConsent?: boolean;
  /** ISO timestamp — set client-side when country peak-time scheduling defers this lead's
   * send; not persisted to Supabase (the authoritative copy lives on campaign_recipients). */
  scheduledFor?: string;
}

export interface CalendarSlot {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // e.g. "11:00 AM", "3:00 PM"
  dateTimeIso: string;
  available: boolean;
  bookedBy?: string;
  leadEmail?: string;
  leadPhone?: string;
  title?: string;
  meetLink?: string;
}

export interface MessageTemplate {
  id: string;
  name: string;
  category: 'discovery' | 'followup' | 'meeting_invite' | 'product_demo' | 're_engagement' | 'custom';
  channel: 'omnichannel' | 'whatsapp' | 'email';
  whatsAppContent: string;
  emailSubject: string;
  emailBody: string;
}

export interface CampaignSettings {
  channelMode: 'omnichannel' | 'whatsapp' | 'email' | 'voice';
  selectedTemplateId: string;
  delayBetweenMessagesSeconds: number;
  autoAdvance: boolean;
  companyName: string;
  senderName: string;
  senderEmail: string;
  senderPhone: string;
  /** Postal address shown in outreach email footers (required by US CAN-SPAM). */
  businessAddress?: string;
  serviceDescription: string;
  defaultCountryCode: string; // e.g. '+91', '+1', '+44'
  includeBookingLink: boolean;
  customInstructions?: string;
  useAiCopywriting?: boolean;
  /** Self-improving prompts (lib/aiLearning.ts): 'auto' (default) applies AI-learned lessons
   * immediately, 'review' queues them for approval, 'off' stops learning and stops using them. */
  aiLearningMode?: 'off' | 'review' | 'auto';
}

export type WhatsAppProvider = 'web_direct' | 'twilio' | 'cloud_api' | 'webhook';
export type EmailProvider = 'mailto_direct' | 'sendgrid' | 'resend' | 'smtp' | 'mailgun' | 'webhook' | 'gmail' | 'outlook';

/** Fields of ChannelApiSettings that never come back to the browser once saved — the
 * database moves them into a server-only table on every write (see
 * divert_org_channel_secrets in supabase/schema.sql). Keep the two lists in sync. */
export const CHANNEL_SECRET_KEYS = [
  'twilioAuthToken',
  'whatsappCloudApiKey',
  'whatsappAppSecret',
  'emailApiKey',
  'smtpPass',
  'vapiApiKey',
] as const;
export type ChannelSecretKey = (typeof CHANNEL_SECRET_KEYS)[number];

/** Sent after the last unanswered AI call when the org hasn't written its own
 * (ChannelApiSettings.voiceFallbackMessage) — see lib/voiceFollowUp.ts. */
export const DEFAULT_VOICE_FALLBACK_MESSAGE =
  "Hi {{first_name}}, this is {{sender_name}} from {{company_name}} — I tried calling you just now. When's a good time to talk? Just reply here with a day and time.";

export type WhatsAppMessageMode = 'text' | 'template';

export interface ChannelApiSettings {
  whatsAppProvider: WhatsAppProvider;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  whatsappCloudApiKey?: string;
  whatsappCloudPhoneId?: string;
  // Shown right next to Phone Number ID on Meta's WhatsApp -> API Setup page. Only needed
  // to click "Subscribe App to WABA" in Settings — not used for sending.
  whatsappBusinessAccountId?: string;
  // From this org's own Meta App Dashboard -> Settings -> Basic -> App Secret. Verifies
  // the X-Hub-Signature-256 header on inbound webhooks are genuinely from *this* org's
  // Meta App — each org brings their own Meta App, so a single shared secret can't work.
  whatsappAppSecret?: string;

  // Free-form text (works only within the 24h customer-service window) vs
  // an approved Message Template (required to initiate cold outreach)
  whatsappMessageMode?: WhatsAppMessageMode;

  // Meta WhatsApp Cloud API approved template
  whatsappTemplateName?: string;
  whatsappTemplateLanguage?: string; // e.g. 'en_US'
  whatsappTemplateVariables?: string[]; // values for {{1}}, {{2}}... — may contain {{name}}/{{company}}/etc tokens

  // Meta caps unique WhatsApp conversations per rolling 24h based on the number's
  // messaging tier (250 -> 1K -> 10K -> 100K as quality rating/volume proves out).
  // A batch larger than this gets auto-split across days by BatchCampaignRunner
  // rather than blasted all at once and risking the number's quality rating.
  safeDailyWhatsAppLimit?: number;

  // Twilio Content Template (WhatsApp)
  twilioContentSid?: string;
  twilioContentVariables?: string[]; // values for Twilio ContentVariables "1","2",...

  // Optional second approved template for campaign follow-ups (lib/messageQueue.ts) —
  // WhatsApp only allows approved templates once 24h have passed without a reply.
  whatsappFollowupTemplateName?: string;
  whatsappFollowupTemplateLanguage?: string;
  whatsappFollowupTemplateVariables?: string[];
  twilioFollowupContentSid?: string;
  twilioFollowupContentVariables?: string[];

  /** Reminders before meetings the AI booked (lib/meetingReminders.ts). Default 'both'. */
  meetingReminders?: 'both' | '24h' | '1h' | 'off';
  // Optional approved template for reminders on WhatsApp (Meta Cloud API) — needed when the
  // lead's last message was over 24 hours ago. Variables may use {{first_name}}, {{name}},
  // {{meeting_time}}, {{meeting_link}}, {{company_name}}. Without it, such reminders go by email.
  whatsappReminderTemplateName?: string;
  whatsappReminderTemplateLanguage?: string;
  whatsappReminderTemplateVariables?: string[];

  emailProvider: EmailProvider;
  emailApiKey?: string;

  // Generic SMTP (Gmail App Password, Zoho Mail, Outlook/Office 365, cPanel, custom)
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFromEmail?: string;

  // Mailgun (uses emailApiKey as its API key)
  mailgunDomain?: string;
  mailgunRegion?: 'us' | 'eu';

  n8nWebhookUrl?: string;

  // AI Voice Agent (Vapi) — bring-your-own account, same graceful-degradation pattern as
  // email/WhatsApp: an org that sets its own keys here always wins over the platform's
  // shared VAPI_* env vars. vapiPublicKey/vapiAssistantId are also read client-side (safe
  // to expose — see VoiceDemoWidget) for the in-browser Live Voice Demo.
  vapiApiKey?: string;
  vapiPublicKey?: string;
  vapiAssistantId?: string;
  vapiPhoneNumberId?: string;
  // Mirrors what's live on the org's Vapi assistant — edited here, pushed to Vapi via
  // ?action=sync-assistant rather than requiring the org to touch Vapi's own dashboard.
  vapiSystemPrompt?: string;
  vapiFirstMessage?: string;

  // Greeting the AI Voice Agent opens with when it answers a call to the org's number.
  vapiInboundFirstMessage?: string;
  // Language the voice agent hears and speaks on calls — a code from lib/voiceLanguages.ts
  // ('auto' to follow the caller). Unset keeps the assistant's own voice and transcriber.
  vapiLanguage?: string;
  vapiVoiceGender?: 'female' | 'male';

  // When an outbound call isn't answered (lib/voiceFollowUp.ts): total tries including the
  // first call, hours between tries, and how to follow up after the last one.
  voiceRetryAttempts?: number;
  voiceRetryHours?: number;
  voiceFallback?: 'whatsapp_email' | 'email' | 'none';
  /** {{first_name}}, {{name}}, {{company}}, {{company_name}}, {{sender_name}} are filled in. */
  voiceFallbackMessage?: string;
  /** Left when voicemail picks up. Blank: English default, or just hang up in other languages. */
  voicemailMessage?: string;
  /** Most outbound AI calls in any 24 hours (lib/callQueue.ts) — keeps the number from being
   * flagged as spam. Default 150. */
  voiceDailyCallLimit?: number;
  /** When the agent says "I'm an AI assistant" (lib/regionRules.ts): 'required' (default) —
   * only to leads in the EU/EEA and US, where the law requires it; 'always'; or 'never'. */
  voiceAiDisclosureMode?: 'required' | 'always' | 'never';
  /** @deprecated earlier on/off switch — false is read as voiceAiDisclosureMode 'never'. */
  voiceAiDisclosure?: boolean;
  /** Say "this call may be recorded" at the start of calls. On unless false. */
  voiceRecordingNotice?: boolean;
  /** Skip AI calls to US numbers unless the lead has recorded consent (TCPA). On unless false. */
  voiceUsConsentRequired?: boolean;

  // Slack — an Incoming Webhook URL (api.slack.com/apps -> your app -> Incoming Webhooks),
  // posted to whenever the AI bot confirms a meeting. No OAuth, no new serverless function:
  // Slack's webhook endpoint is called directly, server-side for real notifications and
  // client-side for the "Send Test" button in Channel Setup.
  slackWebhookUrl?: string;

  /** Browser-only: which secrets are saved server-side (values are never sent back).
   * Filled from get_channel_secret_status() on load; stripped from every write. */
  savedSecrets?: Partial<Record<ChannelSecretKey, boolean>>;

  // Server-only — merged in by lib/orgSettings.ts's getOrgChannelSettings from their own
  // tables, never stored in the settings row and ignored if a browser sends them.
  gmailRefreshToken?: string;
  gmailAddress?: string;
  outlookRefreshToken?: string;
  outlookAddress?: string;
  /** Set only once the org's own domain is verified on the platform's Resend account. */
  verifiedFromAddress?: string;
}

export interface CampaignState {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'paused' | 'completed';
  currentIndex: number;
  totalLeads: number;
  completedWhatsApp: number;
  completedEmail: number;
  meetingsBooked: number;
  failedDispatches: number;
  skippedInvalid: number;
  delaySeconds: number;
  startedAt?: string;
}

export interface ColumnMapping {
  name: string;
  phone: string;
  company: string;
  email: string;
  notes: string;
  country: string;
  /** Optional: a column saying the lead agreed to calls (yes/true/written…). */
  consent?: string;
}

export interface OutreachDispatchLog {
  id: string;
  leadId: string;
  leadName: string;
  recipient: string;
  channel: 'whatsapp' | 'email' | 'voice';
  status: 'sent' | 'delivered' | 'failed';
  timestamp: string;
  subject?: string;
  preview: string;
  directUrl?: string;
  errorDetail?: string;
}

export interface ChatMessage {
  id: string;
  sender: 'ai_agent' | 'client';
  channel: 'whatsapp' | 'email';
  content: string;
  subject?: string;
  timestamp: string;
  status?: 'sent' | 'delivered' | 'read';
}
