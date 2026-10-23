import nodemailer from 'nodemailer';
import { getOrgChannelSettings } from './orgSettings.js';
import { getConnectedCalendar } from './calendarProvider.js';
import { checkCalendarAccess as checkGoogleCalendarAccess } from './googleCalendar.js';
import { checkCalendarAccess as checkMicrosoftCalendarAccess } from './microsoftCalendar.js';
import { sanitizeInboundDomain } from './emailWebhookHandler.js';
import { resolveOrgVoiceSetup } from './orgSettings.js';

export interface HealthStatus {
  ok: boolean;
  message: string;
}

export interface ChannelHealthResult {
  whatsappToken: HealthStatus;
  whatsapp: HealthStatus;
  calendar: HealthStatus;
  email: HealthStatus;
  emailReplyTracking: HealthStatus;
  voice: HealthStatus;
}

/**
 * Live-checks each configured channel exactly the way this got diagnosed by hand, curl by
 * curl, earlier — an expired WhatsApp token, a disabled Calendar API, an unverified email
 * domain — so an org sees it here first instead of a lead's reply silently going nowhere.
 *
 * Shared between the Vercel serverless route (api/whatsapp/subscribe-app.ts) and the local
 * Express dev server (server.ts) so the two never drift out of sync again.
 */
export async function checkChannelHealth(orgId: string): Promise<ChannelHealthResult> {
  const [settings, calendarConnection] = await Promise.all([getOrgChannelSettings(orgId), getConnectedCalendar(orgId)]);

  const apiKey = settings?.whatsappCloudApiKey?.trim();

  // Token validity, checked and reported on its own — separate from whether the specific
  // Phone Number ID below is right, so "is my access token even valid" has a direct answer
  // instead of being inferred from the wording of a combined message.
  const whatsappTokenCheck = (async (): Promise<HealthStatus> => {
    if (settings?.whatsAppProvider !== 'cloud_api' || !apiKey) {
      return { ok: false, message: 'Not configured — add a WhatsApp Cloud API access token in Settings.' };
    }
    try {
      const res = await fetch(`https://graph.facebook.com/v25.0/me?fields=id,name&access_token=${encodeURIComponent(apiKey)}`);
      const data = await res.json();
      if (!res.ok) return { ok: false, message: data?.error?.message || 'Meta rejected this access token.' };
      return { ok: true, message: 'Access token is valid.' };
    } catch (err: any) {
      return { ok: false, message: err.message || 'Failed to reach Meta.' };
    }
  })();

  // A valid token alone doesn't guarantee the specific *Phone Number ID* saved in Settings
  // is right — it could point at a deleted/mismatched number, or one Meta has restricted,
  // while the token check above would still report the token itself as fine. This is what
  // let sends report "Sent" (accepted) while never actually reaching a device: the token
  // check was green, but the phone number behind it wasn't actually checked at all.
  const whatsappCheck = (async (): Promise<HealthStatus> => {
    const tokenResult = await whatsappTokenCheck;
    if (!tokenResult.ok) return { ok: false, message: 'Fix the access token above first.' };
    if (!settings!.whatsappCloudPhoneId) {
      return { ok: false, message: 'No Phone Number ID is set in Settings.' };
    }
    try {
      const phoneId = settings!.whatsappCloudPhoneId.trim();
      const res = await fetch(
        `https://graph.facebook.com/v25.0/${phoneId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status&access_token=${encodeURIComponent(apiKey!)}`
      );
      const data = await res.json();
      if (!res.ok) {
        return {
          ok: false,
          message: `${data?.error?.message || 'Meta rejected this Phone Number ID.'} Double-check the Phone Number ID in Settings matches the one shown in Meta's WhatsApp API Setup page.`,
        };
      }
      if (data.code_verification_status && data.code_verification_status !== 'VERIFIED') {
        return { ok: false, message: `Number ${data.display_phone_number || phoneId} is not verified yet (status: ${data.code_verification_status}).` };
      }
      if (data.quality_rating && data.quality_rating === 'RED') {
        return { ok: false, message: `Number ${data.display_phone_number || phoneId} has a RED quality rating — Meta is restricting its delivery.` };
      }
      const sendingAs = `Sending as ${data.display_phone_number || phoneId}${data.quality_rating ? ` (quality: ${data.quality_rating})` : ''}`;
      // Inbound webhooks are rejected without it (see verifyWhatsAppSignature).
      if (!settings!.whatsappAppSecret) {
        return { ok: false, message: `${sendingAs}, but replies won't reach the AI bot until you add your Meta App Secret.` };
      }
      return { ok: true, message: `${sendingAs}.` };
    } catch (err: any) {
      return { ok: false, message: err.message || 'Failed to verify the Phone Number ID with Meta.' };
    }
  })();

  const calendarCheck = (async (): Promise<HealthStatus> => {
    if (!calendarConnection) {
      return { ok: false, message: 'Not connected — connect Google or Outlook Calendar in Settings.' };
    }
    return calendarConnection.provider === 'google'
      ? checkGoogleCalendarAccess(calendarConnection.refreshToken, calendarConnection.calendarId)
      : checkMicrosoftCalendarAccess(calendarConnection.refreshToken);
  })();

  const emailCheck = (async (): Promise<HealthStatus> => {
    const provider = settings?.emailProvider || 'resend';
    if (provider === 'gmail' || provider === 'outlook') {
      const label = provider === 'gmail' ? 'Gmail' : 'Outlook';
      const address = provider === 'gmail' ? settings?.gmailAddress : settings?.outlookAddress;
      const token = provider === 'gmail' ? settings?.gmailRefreshToken : settings?.outlookRefreshToken;
      if (!token) return { ok: false, message: `${label} isn't connected — click Connect ${label} below.` };
      return { ok: true, message: `Sending from ${address || `your ${label} account`}.` };
    }
    if (provider === 'resend' && !settings?.emailApiKey?.trim()) {
      // The platform's shared account holds every org's domain — only ever report this org's own.
      if (!process.env.RESEND_API_KEY?.trim()) return { ok: false, message: 'Platform email is not set up on the server yet.' };
      if (settings?.verifiedFromAddress) return { ok: true, message: `Sending from your own domain as ${settings.verifiedFromAddress}.` };
      return { ok: true, message: `Using the platform sender (${process.env.RESEND_FROM_ADDRESS?.trim() || 'onboarding@resend.dev'}). Add your own domain below to send as your company.` };
    }
    if (provider === 'resend') {
      const resendKey = settings?.emailApiKey?.trim();
      if (!resendKey) return { ok: true, message: 'Using the platform shared sender (no setup needed).' };
      try {
        const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${resendKey}` } });
        const data = await res.json();
        if (!res.ok) return { ok: false, message: data?.message || 'Resend rejected this API key.' };
        const domains = data?.data || [];
        if (domains.length === 0) return { ok: true, message: 'API key valid (no custom domain — using Resend sandbox sender).' };
        const unverified = domains.filter((d: any) => d.status !== 'verified');
        if (unverified.length > 0) {
          return { ok: false, message: `Domain "${unverified[0].name}" is not verified yet in Resend.` };
        }
        return { ok: true, message: 'API key valid and domain verified.' };
      } catch (err: any) {
        return { ok: false, message: err.message || 'Failed to reach Resend.' };
      }
    }
    if (provider === 'smtp') {
      if (!settings?.smtpHost || !settings?.smtpUser || !settings?.smtpPass) {
        return { ok: false, message: 'SMTP host, username, and password are required.' };
      }
      try {
        const port = Number(settings.smtpPort) || 587;
        const transporter = nodemailer.createTransport({
          host: settings.smtpHost.trim(),
          port,
          secure: settings.smtpSecure ?? port === 465,
          auth: { user: settings.smtpUser.trim(), pass: settings.smtpPass },
        });
        // Real handshake + auth against the SMTP server — no email actually sent.
        await transporter.verify();
        return { ok: true, message: 'SMTP connection and login verified.' };
      } catch (err: any) {
        return { ok: false, message: err.message || 'SMTP server rejected the connection or credentials.' };
      }
    }
    if (provider === 'sendgrid') {
      if (!settings?.emailApiKey) return { ok: false, message: 'SendGrid API key is required.' };
      try {
        const res = await fetch('https://api.sendgrid.com/v3/scopes', {
          headers: { Authorization: `Bearer ${settings.emailApiKey.trim()}` },
        });
        if (res.ok) return { ok: true, message: 'API key is valid.' };
        const data = await res.json().catch(() => null);
        return { ok: false, message: data?.errors?.[0]?.message || 'SendGrid rejected this API key.' };
      } catch (err: any) {
        return { ok: false, message: err.message || 'Failed to reach SendGrid.' };
      }
    }
    if (provider === 'mailgun') {
      if (!settings?.emailApiKey || !settings?.mailgunDomain) return { ok: false, message: 'Mailgun API key and domain are required.' };
      return { ok: true, message: `Configured for domain ${settings.mailgunDomain}.` };
    }
    if (provider === 'webhook') {
      if (!settings?.n8nWebhookUrl) return { ok: false, message: 'A webhook URL is required.' };
      return { ok: true, message: 'Sending via webhook.' };
    }
    // Only truly reachable when emailProvider is explicitly 'mailto_direct'.
    return { ok: true, message: 'Using mailto: links (no API configured).' };
  })();

  // Without EMAIL_INBOUND_DOMAIN and EMAIL_INBOUND_WEBHOOK_SECRET set on the server, every
  // outbound campaign email goes out with NO Reply-To tracking address at all — a prospect
  // hitting "reply" lands in the raw From mailbox instead of routing back to the AI bot,
  // and the whole email side of the booking bot silently never sees a single reply. This
  // used to have no visibility anywhere in the app; it just looked like "replies don't work."
  const emailReplyTrackingCheck: HealthStatus = (() => {
    const rawDomain = process.env.EMAIL_INBOUND_DOMAIN?.trim();
    const secret = process.env.EMAIL_INBOUND_WEBHOOK_SECRET?.trim();
    if (!rawDomain && !secret) {
      return { ok: false, message: 'Not set up — EMAIL_INBOUND_DOMAIN and EMAIL_INBOUND_WEBHOOK_SECRET are missing on the server, so replies never reach the AI bot.' };
    }
    if (!rawDomain) return { ok: false, message: 'EMAIL_INBOUND_DOMAIN is missing on the server — outbound emails have no reply-tracking address.' };
    const domain = sanitizeInboundDomain(rawDomain);
    if (!domain) {
      return {
        ok: false,
        message: `EMAIL_INBOUND_DOMAIN is set to "${rawDomain}", which isn't a valid domain (check for stray quotes, spaces, or a scheme like "https://") — sends were failing outright with an invalid Reply-To.`,
      };
    }
    if (!secret) return { ok: false, message: 'EMAIL_INBOUND_WEBHOOK_SECRET is missing on the server — inbound replies would be rejected.' };
    return { ok: true, message: `Replies route back via reply+...@${domain}.` };
  })();

  // Same resolution as real calls (lib/orgSettings.ts's resolveOrgVoiceSetup): the org's own
  // Vapi account if it brought one, otherwise its assistant and admin-assigned number on ours.
  const voiceCheck = (async (): Promise<HealthStatus> => {
    const { creds, ownAccount, voice } = await resolveOrgVoiceSetup(orgId);
    const apiKey = creds.apiKey || process.env.VAPI_API_KEY;
    const assistantId = creds.assistantId;

    if (!apiKey) return { ok: false, message: 'Voice calling is not set up on the platform yet.' };
    if (!assistantId) return { ok: false, message: 'Not set up — write and save your voice agent prompt below.' };
    try {
      const res = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, message: data?.message || `Vapi rejected this Assistant ID or API Key (${res.status}).` };
      }
      if (!creds.phoneNumberId) {
        return {
          ok: false,
          message: ownAccount
            ? `Assistant "${data?.name || assistantId}" is reachable. Add your Vapi Phone Number ID to place calls.`
            : `Assistant "${data?.name || assistantId}" is ready, but no phone number is assigned to your workspace yet — contact support.`,
        };
      }
      const number = voice?.phoneNumber ? ` on ${voice.phoneNumber}` : '';
      return {
        ok: true,
        message: voice?.inboundEnabled
          ? `Ready${number} — places outbound calls and answers incoming ones.`
          : `Ready for outbound calls${number}. Incoming calls aren't answered by the AI yet — turn that on below.`,
      };
    } catch (err: any) {
      return { ok: false, message: err.message || 'Failed to reach Vapi.' };
    }
  })();

  const [whatsappToken, whatsapp, calendar, email, voice] = await Promise.all([whatsappTokenCheck, whatsappCheck, calendarCheck, emailCheck, voiceCheck]);
  return { whatsappToken, whatsapp, calendar, email, emailReplyTracking: emailReplyTrackingCheck, voice };
}
