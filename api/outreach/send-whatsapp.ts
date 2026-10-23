import { seedConversationFromLead } from '../../lib/whatsappWebhookHandler.js';
import { settingsForSendRequest } from '../../lib/orgSettings.js';
import { getCallerFromAuthHeader } from '../../lib/supabaseServerAuth.js';
import {
  enqueueMessageCampaign,
  processMessageQueue,
  getMessageCampaignStatus,
  setMessageCampaignStatus,
} from '../../lib/messageQueue.js';
import { processCrmEvents } from '../../lib/crm/index.js';
import { sendCampaignWhatsAppMessage } from '../../lib/whatsappCampaignSender.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  body?: any;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  // Server-run WhatsApp/email campaigns (lib/messageQueue.ts) share this route, to stay under
  // Vercel Hobby's 12-function cap.
  const action = req.query?.action as string | undefined;
  if (action) return handleCampaignAction(action, req, res);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { lead, messageText, channelSettings, webhookUrl, templateParams, campaignRecipientId } = req.body || {};
    const resolved = await settingsForSendRequest(req.headers?.authorization as string | undefined, channelSettings);
    if (!resolved.ok) return res.status(401).json({ error: 'Sign in required.', errorDetail: 'Sign in required.' });
    const { orgId, settings } = resolved;

    const result = await sendCampaignWhatsAppMessage(settings, {
      toPhone: lead?.phone || '',
      messageText,
      templateParams,
      webhookUrl,
      webhookContext: lead,
    });

    // Fire-and-forget: let the AI booking bot know this lead once they reply (Meta Cloud
    // API only — the inbound webhook the bot listens on is Meta-specific).
    if (result.provider === 'cloud_api' && result.delivered && orgId) {
      seedConversationFromLead(orgId, lead || {}, campaignRecipientId).catch(() => {});
    }

    const logEntry = {
      id: `wa-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      leadId: lead?.id || 'lead',
      leadName: lead?.name || 'Contact',
      recipient: lead?.phone || '',
      channel: 'whatsapp',
      status: result.delivered ? 'delivered' : 'failed',
      timestamp: new Date().toISOString(),
      preview: (messageText || '').substring(0, 90) + '...',
      directUrl: result.directUrl,
    };

    return res.status(200).json({
      success: true,
      delivered: result.delivered,
      provider: result.provider,
      providerResponse: result.providerResponse,
      errorDetail: result.errorDetail,
      directUrl: result.directUrl,
      log: logEntry,
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error.message || 'Failed to dispatch WhatsApp message',
    });
  }
}

async function handleCampaignAction(action: string, req: ApiRequest, res: ApiResponse) {
  const caller = await getCallerFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!caller) return res.status(401).json({ error: 'Sign in required.' });
  const orgId = caller.orgId;

  if (action === 'campaign-status') {
    return res.status(200).json(await getMessageCampaignStatus(orgId));
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};

  if (action === 'queue-campaign') {
    const result = await enqueueMessageCampaign(orgId, caller.userId, {
      clientIds: Array.isArray(body.clientIds) ? body.clientIds : [],
      channels: Array.isArray(body.channels) ? body.channels : [],
      template: body.template || {},
      useAi: !!body.useAi,
      peakScheduling: !!body.peakScheduling,
      sendGapSeconds: Number(body.sendGapSeconds) || 2,
      followupDays: Number(body.followupDays) || null,
      followupTemplate: body.followupTemplate || null,
      templateName: typeof body.templateName === 'string' ? body.templateName.slice(0, 200) : null,
    });
    if (!result.ok) return res.status(400).json(result);
    // Get the first messages out now; the open page and the scheduler send the rest.
    await processMessageQueue({ budgetMs: 15000, onlyOrgId: orgId });
    return res.status(200).json({ ...result, status: await getMessageCampaignStatus(orgId) });
  }

  // Called every few seconds by the open Campaigns page, so sends move quickly while someone's
  // watching; the scheduled dispatcher carries on when nobody is.
  if (action === 'campaign-pump') {
    await processMessageQueue({ budgetMs: 18000, onlyOrgId: orgId });
    await processCrmEvents({ budgetMs: 5000, onlyOrgId: orgId });
    return res.status(200).json(await getMessageCampaignStatus(orgId));
  }

  if (action === 'campaign-control') {
    const control = body.control;
    if (control !== 'pause' && control !== 'resume' && control !== 'cancel') {
      return res.status(400).json({ error: 'control must be pause, resume or cancel.' });
    }
    await setMessageCampaignStatus(orgId, control);
    return res.status(200).json({ ok: true, status: await getMessageCampaignStatus(orgId) });
  }

  return res.status(400).json({ error: `Unknown action "${action}".` });
}
