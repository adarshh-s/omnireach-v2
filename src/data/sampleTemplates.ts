import { MessageTemplate, CampaignSettings } from '../types';

export const DEFAULT_TEMPLATES: MessageTemplate[] = [
  {
    id: 'tpl-1',
    name: 'B2B Discovery & Meeting Invitation',
    category: 'discovery',
    channel: 'omnichannel',
    whatsAppContent: `Hi {{name}} 👋! {{sender_name}} from {{company_name}} here.

I noticed your work at *{{company}}* and wanted to share how we help businesses automate repetitive client outreach and sync replies directly to Google Sheets & CRM.

Would you be open to a quick 10-minute call this week?

Just reply with a day/time that works for you and I'll lock it in! 🚀`,
    emailSubject: `Automating {{company}}'s client outreach workflow (Quick Chat)`,
    emailBody: `Hi {{name}},

I hope you're having a productive week.

I'm reaching out from {{company_name}}. We specialize in helping high-growth teams at companies like {{company}} eliminate manual client outreach by connecting spreadsheets directly to automated WhatsApp and Email dispatch with instant AI follow-ups.

Our clients typically see a 4x increase in client engagement rates while cutting 15+ hours of manual follow-up every single week.

Would you be open to a brief 10-minute introduction this week?

Just reply with a day/time that works for you and I'll get it on the calendar.

Best regards,

{{sender_name}}
{{company_name}} | Growth & Automation
Email: {{sender_email}}
Phone: {{sender_phone}}`,
  },
  {
    id: 'tpl-2',
    name: 'Direct Meeting Invitation',
    category: 'meeting_invite',
    channel: 'omnichannel',
    whatsAppContent: `Hey {{name}}! 📅

{{sender_name}} here from {{company_name}}. We just opened a few time slots for {{company}} to connect on what we've been working on.

Just reply with a day/time that works for you and I'll lock it in!

Looking forward to connecting!`,
    emailSubject: `Quick 10-min overview for {{name}} ({{company}})`,
    emailBody: `Hi {{name}},

Following up on our automation initiative for {{company}}. We've prepared a quick walkthrough showing how your team can upload an Excel sheet and instantly dispatch personalized WhatsApp messages & emails.

Just reply with a day/time that works for you and I'll get it on the calendar.

Best regards,
{{sender_name}}
{{company_name}}`,
  },
  {
    id: 'tpl-3',
    name: 'Gentle Value-Add Follow-up',
    category: 'followup',
    channel: 'omnichannel',
    whatsAppContent: `Hi {{name}}! Just following up on my previous message regarding {{company}}'s client communication workflow.

Did you have a chance to think it over?

Happy to set up a quick 5-min walk-through — just reply with a day/time that works for you! 😊`,
    emailSubject: `Quick follow-up regarding {{company}}'s outreach automation`,
    emailBody: `Hi {{name}},

I know how busy your schedule gets, so I'm keeping this very brief.

I wanted to quickly check if you had a chance to review my previous email about streamlining {{company}}'s outreach via WhatsApp and Email.

If you have 10 minutes this week, just reply with a day/time that works for you and I'll get it on the calendar.

Or feel free to reply directly to this email with any questions!

Warm regards,
{{sender_name}}
{{company_name}}`,
  },
  {
    id: 'tpl-4',
    name: 'Product Showcase & ROI Overview',
    category: 'product_demo',
    channel: 'omnichannel',
    whatsAppContent: `Hello {{name}}! 💡 Quick one for {{company}} —

{{sender_name}} here from {{company_name}}. Thought this might be relevant to what you're working on.

Happy to walk you through it in a quick 10-min call — just reply with a day/time that works for you!`,
    emailSubject: `A quick idea for {{company}}`,
    emailBody: `Hi {{name}},

I wanted to reach out because I think what we're doing at {{company_name}} could be genuinely useful for {{company}}.

Would you be open to a brief 10-minute call this week to see if it's a fit? Just reply with a day/time that works for you.

Best,
{{sender_name}}
{{company_name}}`,
  },
];

export const DEFAULT_CAMPAIGN_SETTINGS: CampaignSettings = {
  channelMode: 'omnichannel',
  selectedTemplateId: 'tpl-1',
  delayBetweenMessagesSeconds: 2,
  autoAdvance: true,
  companyName: '',
  senderName: '',
  senderEmail: '',
  senderPhone: '',
  serviceDescription: '',
  defaultCountryCode: '+971',
  includeBookingLink: true,
  customInstructions: 'Keep messages conversational, clear, friendly, and focused on booking a quick call.',
  useAiCopywriting: false,
};
