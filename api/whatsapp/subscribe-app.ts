import { getCallerFromAuthHeader, getUserFromAuthHeader, isAdminEmail } from '../../lib/supabaseServerAuth.js';
import { subscribeAppToWaba } from '../../lib/whatsappSubscribe.js';
import { checkChannelHealth } from '../../lib/channelHealth.js';
import { adminListOrgs, adminSetOrgAccess, getOrgChannelSettings, saveOrgVoice } from '../../lib/orgSettings.js';
import { listTeam, inviteTeamMember, removeTeamMember } from '../../lib/teamMembers.js';
import {
  getOrgEmailDomain,
  addOrgEmailDomain,
  verifyOrgEmailDomain,
  updateOrgEmailFromAddress,
  removeOrgEmailDomain,
} from '../../lib/emailDomains.js';
import { disconnectEmailOAuth } from '../../lib/emailOAuth.js';
import { listSuppression, addManyToSuppression, removeFromSuppression } from '../../lib/suppression.js';
import { configuredCrms, disconnectCrm, importFromCrm, processCrmEvents } from '../../lib/crm/index.js';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin.js';
import { listPhoneNumbers } from '../../lib/vapiClient.js';
import { enableInboundCalls, getPublicBaseUrl } from '../../lib/voiceCalls.js';
import { getOrgUsage, adminUsageByOrg, setOrgLimits } from '../../lib/usage.js';
import { logAudit, listAudit } from '../../lib/auditLog.js';
import { exportLeadData, eraseLeadData } from '../../lib/leadData.js';

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

/**
 * The workspace "account" route: WhatsApp app subscription, channel health, team members,
 * the org's own email domain, and the admin dashboard's actions. One file with ?action=...
 * branches rather than one route each, to stay under Vercel's Hobby-plan
 * 12-serverless-function cap. server.ts (local dev) calls this same handler.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  const action = (req.query?.action as string | undefined) || '';
  const authHeader = req.headers?.authorization as string | undefined;

  // Admin dashboard actions — gated on ADMIN_EMAIL, not just "signed in". No self-serve
  // subscription checkout; access is unlocked manually after a client pays outside the app.
  if (action.startsWith('admin-')) {
    const user = await getUserFromAuthHeader(authHeader);
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (!isAdminEmail(user.email)) return res.status(403).json({ error: 'Not authorized.' });
    return handleAdminAction(action, req, res, { userId: user.id, email: user.email || null });
  }

  const caller = await getCallerFromAuthHeader(authHeader);
  if (!caller) {
    return res.status(401).json({ error: 'Sign in required.' });
  }
  const orgId = caller.orgId;
  const actor = { userId: caller.userId, email: caller.email };
  const audit = (action: string, target?: string | null, detail?: Record<string, unknown>) => logAudit(orgId, actor, action, target, detail);

  if (req.method === 'GET') {
    if (action === 'health') return res.status(200).json(await checkChannelHealth(orgId));
    if (action === 'team') return res.status(200).json({ members: await listTeam(orgId), myRole: caller.role, myUserId: caller.userId });
    if (action === 'email-domain') return res.status(200).json({ domain: await getOrgEmailDomain(orgId) });
    if (action === 'do-not-contact') return res.status(200).json(await listSuppression(orgId));
    if (action === 'crm') return res.status(200).json(await crmStatus(orgId));
    if (action === 'usage') return res.status(200).json(await getOrgUsage(orgId));
    if (action === 'audit-log') {
      if (caller.role === 'member') return res.status(403).json({ error: 'Only the workspace owner or an admin can see the activity log.' });
      return res.status(200).json({ entries: await listAudit(orgId) });
    }
    if (action === 'lead-export') {
      const result = await exportLeadData(orgId, actor, String(req.query?.id || ''));
      return res.status(result.ok ? 200 : 404).json(result);
    }
    // Not a credential — Meta's webhook handshake echo string, which orgs paste into their own
    // Meta App's webhook config. The real access control is the X-Hub-Signature-256 check.
    return res.status(200).json({ verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const respond = (result: { ok: boolean }) => res.status(result.ok ? 200 : 400).json(result);

  switch (action) {
    case 'team-invite': {
      const redirectTo = getPublicBaseUrl(req.headers) || process.env.APP_URL?.trim() || undefined;
      const result = await inviteTeamMember(caller, body.email, body.role === 'admin' ? 'admin' : 'member', redirectTo);
      if (result.ok) await audit('team.invited', String(body.email || ''), { role: body.role === 'admin' ? 'admin' : 'member' });
      return respond(result);
    }
    case 'team-remove': {
      const result = await removeTeamMember(caller, body.userId);
      if (result.ok) await audit('team.removed', String(body.userId || ''));
      return respond(result);
    }
    case 'lead-erase': {
      // Deleting everything about a person can't be undone — owner/admin only.
      if (caller.role === 'member') return res.status(403).json({ ok: false, error: 'Only the workspace owner or an admin can erase a lead’s data.' });
      return respond(await eraseLeadData(orgId, actor, String(body.clientId || ''), body.keepOnDoNotContact !== false));
    }
    case 'email-domain-add':
      await audit('email_domain.added', String(body.domain || ''));
      return respond(await addOrgEmailDomain(orgId, body.domain, body.fromAddress));
    case 'email-domain-verify':
      return respond(await verifyOrgEmailDomain(orgId));
    case 'email-domain-from':
      return respond(await updateOrgEmailFromAddress(orgId, body.fromAddress));
    case 'email-domain-remove':
      await audit('email_domain.removed');
      return respond(await removeOrgEmailDomain(orgId));
    case 'do-not-contact-add': {
      const added = await addManyToSuppression(orgId, String(body.values || ''));
      await audit('do_not_contact.added', null, { added: added.added });
      return res.status(200).json({ ok: true, ...added });
    }
    case 'do-not-contact-remove':
      // Taking someone off the list lets campaigns contact them again — owner/admin only.
      if (caller.role === 'member') return res.status(403).json({ ok: false, error: 'Only the workspace owner or an admin can remove entries.' });
      await removeFromSuppression(orgId, String(body.id || ''));
      await audit('do_not_contact.removed', String(body.id || ''));
      return res.status(200).json({ ok: true });
    case 'crm-disconnect':
      if (caller.role === 'member') return res.status(403).json({ ok: false, error: 'Only the workspace owner or an admin can disconnect the CRM.' });
      await disconnectCrm(orgId);
      await audit('crm.disconnected');
      return res.status(200).json({ ok: true });
    case 'crm-sync':
      await processCrmEvents({ budgetMs: 20000, onlyOrgId: orgId });
      return res.status(200).json({ ok: true, ...(await crmStatus(orgId)) });
    case 'crm-import':
      try {
        const result = await importFromCrm(orgId, Math.min(2000, Number(body.limit) || 500));
        await audit('crm.imported', null, { imported: (result as any).imported ?? null });
        return res.status(200).json({ ok: true, ...result });
      } catch (err: any) {
        return res.status(400).json({ ok: false, error: err?.message || 'Could not import from the CRM.' });
      }
    case 'email-oauth-disconnect':
      await disconnectEmailOAuth(orgId);
      await audit('email_account.disconnected');
      return res.status(200).json({ ok: true });
  }

  // Default POST: subscribe this app to the org's WhatsApp Business Account so inbound
  // webhooks actually deliver — a step Meta requires but doesn't surface in its dashboard.
  // The token is the one typed into the form if it isn't saved yet, else the saved one
  // (the browser never gets saved secrets back).
  const accessToken = body.accessToken || (await getOrgChannelSettings(orgId))?.whatsappCloudApiKey;
  const { wabaId } = body;
  if (!accessToken || !wabaId) {
    return res.status(400).json({ error: 'Save your WhatsApp access token and Business Account ID first.' });
  }
  const result = await subscribeAppToWaba(accessToken, wabaId);
  return res.status(result.ok ? 200 : 400).json(result);
}

async function handleAdminAction(action: string, req: ApiRequest, res: ApiResponse, admin: { userId: string; email: string | null }) {
  if (action === 'admin-list-orgs') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const [orgs, usage] = await Promise.all([adminListOrgs(), adminUsageByOrg()]);
    return res.status(200).json({ orgs, usage });
  }

  // Numbers on the platform's Vapi account, to pick from when assigning one to an org.
  if (action === 'admin-list-voice-numbers') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const apiKey = process.env.VAPI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'VAPI_API_KEY is not set on the server.' });
    const result = await listPhoneNumbers(apiKey);
    return res.status(result.ok ? 200 : 400).json(result);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { orgId: targetOrgId, status, phoneNumberId } = req.body || {};
  if (!targetOrgId) return res.status(400).json({ error: 'orgId is required.' });

  // Monthly limits per org (lib/usage.ts); a blank field means no limit.
  if (action === 'admin-set-limits') {
    const limits = await setOrgLimits(targetOrgId, req.body?.limits || {});
    await logAudit(targetOrgId, admin, 'admin.limits_changed', null, limits);
    return res.status(200).json({ ok: true, limits });
  }

  if (action === 'admin-set-org-access') {
    if (status !== 'active' && status !== 'locked') {
      return res.status(400).json({ error: 'A status of "active" or "locked" is required.' });
    }
    await adminSetOrgAccess(targetOrgId, status);
    await logAudit(targetOrgId, admin, status === 'active' ? 'admin.unlocked' : 'admin.locked');
    return res.status(200).json({ ok: true });
  }

  // Gives an org its own number (or takes it away with phoneNumberId: null), then points the
  // number's incoming calls at the org's AI agent.
  if (action === 'admin-assign-voice-number') {
    if (!phoneNumberId) {
      const cleared = await saveOrgVoice(targetOrgId, { phone_number_id: null, phone_number: null, inbound_enabled: false });
      return res.status(cleared.error ? 400 : 200).json(cleared.error ? { ok: false, error: cleared.error } : { ok: true });
    }
    const apiKey = process.env.VAPI_API_KEY;
    if (!apiKey) return res.status(400).json({ ok: false, error: 'VAPI_API_KEY is not set on the server.' });
    const listed = await listPhoneNumbers(apiKey);
    const number = listed.numbers?.find((n) => n.id === phoneNumberId);
    if (!number) return res.status(400).json({ ok: false, error: listed.error || "That number isn't on the platform's Vapi account." });

    const saved = await saveOrgVoice(targetOrgId, { phone_number_id: number.id, phone_number: number.number, inbound_enabled: false });
    if (saved.error) return res.status(400).json({ ok: false, error: saved.error });
    const inbound = await enableInboundCalls(targetOrgId, getPublicBaseUrl(req.headers));
    return res.status(200).json({
      ok: true,
      phoneNumber: number.number,
      inboundEnabled: inbound.ok,
      inboundError: inbound.ok ? undefined : inbound.error,
    });
  }

  return res.status(400).json({ error: `Unknown action "${action}".` });
}

/** The org's CRM connection and sync health, plus which CRMs the platform has set up. */
async function crmStatus(orgId: string) {
  const supabase = getSupabaseAdmin();
  const available = configuredCrms();
  if (!supabase) return { available, connection: null, pending: 0, failed: 0 };
  const [{ data: row }, { count: pending }, { count: failed }] = await Promise.all([
    supabase.from('org_crm').select('provider, connected_account, last_sync_at, last_error').eq('org_id', orgId).maybeSingle(),
    supabase.from('crm_events').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'pending'),
    supabase.from('crm_events').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'failed'),
  ]);
  return {
    available,
    connection: row
      ? { provider: row.provider, account: row.connected_account, lastSyncAt: row.last_sync_at, lastError: row.last_error }
      : null,
    pending: pending || 0,
    failed: failed || 0,
  };
}
