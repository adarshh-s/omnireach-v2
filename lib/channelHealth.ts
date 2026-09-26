import nodemailer from 'nodemailer';
import { getOrgChannelSettings, getOrgGoogleCalendarToken } from './orgSettings.js';
import { checkCalendarAccess } from './googleCalendar.js';
import { sanitizeInboundDomain } from './emailWebhookHandler.js';

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
  const [settings, calendarToken] = await Promise.all([getOrgChannelSettings(orgId), getOrgGoogleCalendarToken(orgId)]);

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
      return { ok: true, message: `Sending as ${data.display_phone_number || phoneId}${data.quality_rating ? ` (quality: ${data.quality_rating})` : ''}.` };
    } catch (err: any) {
      return { ok: false, message: err.message || 'Failed to verify the Phone Number ID with Meta.' };
    }
  })();

  const calendarCheck = (async (): Promise<HealthStatus> => {
    if (!calendarToken) {
      return { ok: false, message: 'Not connected — connect Google Calendar in Settings.' };
    }
    return checkCalendarAccess(calendarToken.refreshToken, calendarToken.calendarId);
  })();

  const emailCheck = (async (): Promise<HealthStatus> => {
    const provider = settings?.emailProvider || 'resend';
    if (provider === 'resend') {
      const resendKey = settings?.emailApiKey?.trim() || process.env.RESEND_API_KEY?.trim();
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

  // Same bring-your-own-account fallback as startVapiCall (lib/vapiClient.ts): the org's own
  // keys win field-by-field, the platform's shared VAPI_* env vars fill in the rest.
  const voiceCheck = (async (): Promise<HealthStatus> => {
    const apiKey = settings?.vapiApiKey?.trim() || process.env.VAPI_API_KEY;
    const assistantId = settings?.vapiAssistantId?.trim() || process.env.VAPI_ASSISTANT_ID;
    const phoneNumberId = settings?.vapiPhoneNumberId?.trim() || process.env.VAPI_PHONE_NUMBER_ID;

    if (!apiKey || !assistantId) {
      return { ok: false, message: 'Not configured — add your Vapi API Key and Assistant ID in Channel Setup.' };
    }
    try {
      const res = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, message: data?.message || `Vapi rejected this Assistant ID or API Key (${res.status}).` };
      }
      if (!phoneNumberId) {
        return { ok: true, message: `Assistant "${data?.name || assistantId}" is reachable. Add a Phone Number ID to place real outbound calls (the in-browser Live Voice Demo works either way).` };
      }
      return { ok: true, message: `Assistant "${data?.name || assistantId}" is reachable and ready for outbound calls.` };
    } catch (err: any) {
      return { ok: false, message: err.message || 'Failed to reach Vapi.' };
    }
  })();

  const [whatsappToken, whatsapp, calendar, email, voice] = await Promise.all([whatsappTokenCheck, whatsappCheck, calendarCheck, emailCheck, voiceCheck]);
  return { whatsappToken, whatsapp, calendar, email, emailReplyTracking: emailReplyTrackingCheck, voice };
}
