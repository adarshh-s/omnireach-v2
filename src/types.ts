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
  | 'Failed';

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
  serviceDescription: string;
  defaultCountryCode: string; // e.g. '+91', '+1', '+44'
  includeBookingLink: boolean;
  customInstructions?: string;
  useAiCopywriting?: boolean;
}

export type WhatsAppProvider = 'web_direct' | 'twilio' | 'cloud_api' | 'webhook';
export type EmailProvider = 'mailto_direct' | 'sendgrid' | 'resend' | 'smtp' | 'mailgun' | 'webhook';

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
