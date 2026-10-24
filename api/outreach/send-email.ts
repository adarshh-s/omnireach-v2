import { settingsForSendRequest, getOrgProfile } from '../../lib/orgSettings.js';
import { withComplianceFooter, unsubscribeHeaders } from '../../lib/emailCompliance.js';
import { buildEmailReplyToAddress, seedEmailConversationFromLead } from '../../lib/emailWebhookHandler.js';
import { sendEmailViaOrgProvider } from '../../lib/emailSender.js';
import { recordUsage, usageRoom, limitReachedMessage } from '../../lib/usage.js';

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
    const resolved = await settingsForSendRequest(req.headers?.authorization as string | undefined, channelSettings);
    if (!resolved.ok) return res.status(401).json({ success: false, delivered: false, error: 'Sign in required.', errorDetail: 'Sign in required.' });
    const { orgId, settings } = resolved;
    const replyTo = buildEmailReplyToAddress(campaignRecipientId, lead?.id) || undefined;

    const mailtoUrl = `mailto:${lead?.email || ''}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
    if (orgId && (await usageRoom(orgId, 'emails')) <= 0) {
      return res.status(200).json({ success: true, delivered: false, errorDetail: limitReachedMessage('emails'), mailtoUrl, limitReached: true });
    }

    // Outreach emails carry the sender's address and an unsubscribe link (lib/emailCompliance.ts).
    const compliant = orgId
      ? withComplianceFooter(orgId, lead?.email || '', body || '', await getOrgProfile(orgId))
      : { body: body || '', unsubscribeUrl: null };
    const result = await sendEmailViaOrgProvider(settings, {
      to: lead?.email || '',
      toName: lead?.name,
      subject: subject || 'Meeting Request',
      body: compliant.body,
      headers: unsubscribeHeaders(compliant.unsubscribeUrl),
      fromName: senderName || 'OmniReach AI',
      fromAddress: senderEmail,
      replyTo,
      orgId,
      webhookUrl,
      webhookContext: lead,
    });

    if (result.ok) await recordUsage(orgId, 'emails');
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
