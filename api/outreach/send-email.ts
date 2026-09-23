import { getOrgIdFromAuthHeader } from '../../lib/supabaseServerAuth.js';
import { buildEmailReplyToAddress, seedEmailConversationFromLead } from '../../lib/emailWebhookHandler.js';
import { sendEmailViaOrgProvider } from '../../lib/emailSender.js';

interface ApiRequest {
  method?: string;
  body?: any;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { lead, subject, body, channelSettings, webhookUrl, senderName, senderEmail, campaignRecipientId } = req.body || {};
    const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
    const replyTo = buildEmailReplyToAddress(campaignRecipientId, lead?.id) || undefined;

    const mailtoUrl = `mailto:${lead?.email || ''}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;

    const result = await sendEmailViaOrgProvider(channelSettings, {
      to: lead?.email || '',
      toName: lead?.name,
      subject: subject || 'Meeting Request',
      body: body || '',
      fromName: senderName || 'OmniReach AI',
      fromAddress: senderEmail,
      replyTo,
      webhookUrl,
      webhookContext: lead,
    });

    // Fire-and-forget: let the AI booking bot know this lead once they reply.
    if (result.ok && orgId && replyTo) {
      seedEmailConversationFromLead(orgId, lead || {}, campaignRecipientId, subject).catch(() => {});
    }

    const logEntry = {
      id: `em-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      leadId: lead?.id || 'lead',
      leadName: lead?.name || 'Contact',
      recipient: lead?.email || '',
      channel: 'email',
      status: result.ok ? 'delivered' : 'failed',
      timestamp: new Date().toISOString(),
      subject: subject || 'Outreach',
      preview: (body || '').substring(0, 90) + '...',
      directUrl: mailtoUrl,
    };

    return res.status(200).json({
      success: true,
      delivered: result.ok,
      provider: result.provider,
      providerResponse: result.providerResponse,
      errorDetail: result.error || null,
      mailtoUrl,
      log: logEntry,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      delivered: false,
      error: error.message || 'Failed to dispatch email',
      errorDetail: error.message,
    });
  }
}
