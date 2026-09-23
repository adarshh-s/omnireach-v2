import type { ChannelApiSettings } from '../src/types.js';

export interface CampaignWhatsAppParams {
  toPhone: string;
  messageText: string;
  templateParams?: string[];
  /** Explicit webhook override — takes priority over channelSettings.n8nWebhookUrl. */
  webhookUrl?: string;
  /** Included in the (optional) webhook notification payload for context. */
  webhookContext?: unknown;
}

export interface CampaignWhatsAppResult {
  delivered: boolean;
  provider: string;
  providerResponse: unknown;
  errorDetail: string | null;
  directUrl: string;
}

/**
 * Sends one campaign WhatsApp message via whichever provider is configured
 * (Twilio / Meta Cloud API / generic webhook), given the org's channel settings.
 * Shared by the interactive send route (api/outreach/send-whatsapp.ts, server.ts) and
 * the headless scheduled dispatcher (api/cron/dispatch-scheduled.ts) — both need
 * byte-identical send behavior, since credentials/provider choice are looked up once
 * by orgId and neither caller re-implements the provider branching itself.
 */
export async function sendCampaignWhatsAppMessage(
  settings: ChannelApiSettings | null | undefined,
  params: CampaignWhatsAppParams
): Promise<CampaignWhatsAppResult> {
  const { toPhone, messageText, templateParams, webhookUrl, webhookContext } = params;
  const phoneDigits = (toPhone || '').replace(/[^0-9]/g, '');
  const encodedText = encodeURIComponent(messageText || '');
  const directUrl = `https://wa.me/${phoneDigits}?text=${encodedText}`;

  let delivered = false;
  let providerResponse: unknown = null;
  let errorDetail: string | null = null;

  const provider = settings?.whatsAppProvider || 'web_direct';
  const useTemplate = settings?.whatsappMessageMode === 'template';

  // 1. Twilio WhatsApp
  if (provider === 'twilio' && settings?.twilioAccountSid && settings?.twilioAuthToken) {
    if (useTemplate && !settings.twilioContentSid) {
      errorDetail = 'Template mode is on but no Twilio Content SID is configured. Please add one in Settings.';
    } else {
      try {
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${settings.twilioAccountSid}/Messages.json`;
        const fromNumber = settings.twilioFromNumber || '+14155238886';
        const formattedFrom = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;
        const formattedTo = `whatsapp:+${phoneDigits}`;

        const formData = new URLSearchParams();
        formData.append('From', formattedFrom);
        formData.append('To', formattedTo);

        if (useTemplate) {
          formData.append('ContentSid', settings.twilioContentSid!.trim());
          if (Array.isArray(templateParams) && templateParams.length > 0) {
            const contentVariables: Record<string, string> = {};
            templateParams.forEach((val, idx) => {
              contentVariables[String(idx + 1)] = val;
            });
            formData.append('ContentVariables', JSON.stringify(contentVariables));
          }
        } else {
          formData.append('Body', messageText || '');
        }

        const authHeader = `Basic ${Buffer.from(`${settings.twilioAccountSid}:${settings.twilioAuthToken}`).toString('base64')}`;

        const twilioRes = await fetch(twilioUrl, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        });

        const twilioData = await twilioRes.json();
        if (twilioRes.ok) {
          delivered = true;
          providerResponse = { provider: 'twilio', sid: twilioData.sid, status: twilioData.status };
        } else {
          errorDetail = twilioData.message || 'Twilio API returned an error';
          providerResponse = twilioData;
        }
      } catch (err: any) {
        errorDetail = err.message || 'Failed connecting to Twilio';
      }
    }
  }
  // 2. Meta WhatsApp Cloud API
  else if (provider === 'cloud_api' && settings?.whatsappCloudApiKey && settings?.whatsappCloudPhoneId) {
    if (useTemplate && !settings.whatsappTemplateName) {
      errorDetail = 'Template mode is on but no approved template name is configured. Please add one in Settings.';
    } else {
      try {
        const phoneId = settings.whatsappCloudPhoneId.trim();
        const metaUrl = `https://graph.facebook.com/v25.0/${phoneId}/messages`;

        const messageBody = useTemplate
          ? {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: phoneDigits,
              type: 'template',
              template: {
                name: settings.whatsappTemplateName!.trim(),
                language: { code: settings.whatsappTemplateLanguage || 'en_US' },
                ...(Array.isArray(templateParams) && templateParams.length > 0
                  ? {
                      components: [
                        {
                          type: 'body',
                          parameters: templateParams.map((val) => ({ type: 'text', text: val })),
                        },
                      ],
                    }
                  : {}),
              },
            }
          : {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: phoneDigits,
              type: 'text',
              text: { preview_url: true, body: messageText },
            };

        const metaRes = await fetch(metaUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.whatsappCloudApiKey.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(messageBody),
        });

        const metaData = await metaRes.json();
        const msgStatus = metaData.messages?.[0]?.message_status;

        if (metaRes.ok && metaData.messages?.[0]?.id && msgStatus === 'held_for_quality_assessment') {
          delivered = false;
          errorDetail =
            'Meta accepted the request but is holding this message for quality assessment — it will not be delivered. This is common for brand-new test numbers/business accounts with no quality rating yet. Check Meta Business Suite → WhatsApp Manager → Phone Numbers for the quality status.';
          providerResponse = metaData;
        } else if (metaRes.ok && metaData.messages?.[0]?.id) {
          delivered = true;
          providerResponse = { provider: 'meta_cloud_api', messageId: metaData.messages[0].id, contacts: metaData.contacts };
        } else {
          const baseError = metaData.error?.message || 'Meta Cloud API error';
          errorDetail =
            metaData.error?.code === 132000
              ? `${baseError} — the number of Body Variables configured in Settings doesn't match the {{n}} placeholders in your approved template. Check the exact count and try again.`
              : baseError;
          providerResponse = metaData;
        }
      } catch (err: any) {
        errorDetail = err.message || 'Failed connecting to Meta Cloud API';
      }
    }
  }
  // 3. Custom Webhook as primary delivery (e.g. n8n workflow owning the actual WhatsApp send)
  else if (provider === 'webhook' && (webhookUrl || settings?.n8nWebhookUrl)) {
    try {
      const targetUrl = webhookUrl || settings?.n8nWebhookUrl!;
      const hookRes = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'whatsapp_outreach_dispatch',
          timestamp: new Date().toISOString(),
          lead: webhookContext,
          messageText,
          directUrl,
        }),
      });
      delivered = hookRes.ok;
      providerResponse = { provider: 'webhook', status: hookRes.status };
      if (!hookRes.ok) {
        errorDetail = `Webhook returned HTTP ${hookRes.status}`;
      }
    } catch (err: any) {
      errorDetail = err.message || 'Webhook trigger failed';
    }
  }
  // 4. Unconfigured provider (missing required credentials)
  else if (provider === 'twilio' || provider === 'cloud_api' || provider === 'webhook') {
    errorDetail =
      provider === 'twilio'
        ? 'Twilio Account SID and Auth Token are required. Please configure them in Settings.'
        : provider === 'cloud_api'
          ? 'WhatsApp Cloud API access token and Phone Number ID are required. Please configure them in Settings.'
          : 'A webhook URL is required. Set it under n8n / Webhook in Settings.';
  }
  // 'web_direct' (the default): this function runs server-side (the automated batch
  // runner, the scheduled dispatcher) where there's no browser to open a wa.me link in —
  // so a web_direct org's automated sends can never actually reach anyone here. This used
  // to just return delivered:true unconditionally, which is exactly why campaigns showed
  // "Delivered" while nothing was ever really sent. web_direct only makes sense for a human
  // manually clicking a wa.me link one at a time (see MessageSimulator), not for automation.
  else {
    errorDetail =
      'WhatsApp is set to "Open in WhatsApp Web" mode, which only works for manual one-at-a-time sends — it can\'t be used for automated campaigns. Switch to WhatsApp Cloud API (or Twilio) in Channel Setup to let campaigns send automatically.';
  }

  // 5. Optional n8n / Custom Webhook notification (skip if the webhook was already the primary delivery above)
  if (provider !== 'webhook') {
    const activeWebhook = webhookUrl || settings?.n8nWebhookUrl;
    if (activeWebhook) {
      try {
        await fetch(activeWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'whatsapp_outreach_dispatch',
            timestamp: new Date().toISOString(),
            provider,
            lead: webhookContext,
            messageText,
            directUrl,
            delivered,
          }),
        });
      } catch (e) {
        console.warn('External webhook notification failed:', e);
      }
    }
  }

  return { delivered, provider, providerResponse, errorDetail, directUrl };
}
