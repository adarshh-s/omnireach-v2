import type { CampaignSettings } from '../src/types.js';
import { buildUnsubscribeUrl, verifyUnsubscribeToken, addToSuppression } from './suppression.js';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { emitCrmEvent } from './crm/index.js';

/**
 * What every outreach email needs to be compliant: the sender's company and postal address
 * (US CAN-SPAM), a visible unsubscribe link, and the one-click unsubscribe headers Gmail,
 * Yahoo and Outlook require of bulk senders (RFC 8058). Used for campaign emails and the
 * missed-call follow-up — not for the AI's replies inside a conversation the lead started.
 */

export interface OutreachEmailExtras {
  body: string;
  unsubscribeUrl: string | null;
}

export function withComplianceFooter(orgId: string, toEmail: string, body: string, profile: CampaignSettings | null): OutreachEmailExtras {
  const unsubscribeUrl = buildUnsubscribeUrl(orgId, toEmail);
  const sender = [profile?.companyName, profile?.businessAddress].filter(Boolean).join(' · ');
  const optOut = unsubscribeUrl ? `Not interested? Unsubscribe: ${unsubscribeUrl}` : 'Not interested? Reply STOP and we won’t email you again.';
  return { body: `${body.trimEnd()}\n\n—\n${sender ? `${sender}\n` : ''}${optOut}`, unsubscribeUrl };
}

/** RFC 8058 headers — the inbox's own "Unsubscribe" button POSTs to the URL. */
export function unsubscribeHeaders(unsubscribeUrl: string | null | undefined): Record<string, string> {
  return unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
}

/** Handles the unsubscribe link. GET shows a confirm button (link scanners in mail systems
 * open links, so a GET alone must never unsubscribe); POST — the button, or the inbox's
 * one-click unsubscribe — unsubscribes immediately. */
export async function handleUnsubscribe(method: string | undefined, token: string | undefined): Promise<{ status: number; html: string }> {
  const target = verifyUnsubscribeToken(token);
  if (!target) return { status: 400, html: page('This unsubscribe link isn’t valid', 'It may have been copied incompletely. Reply STOP to the email instead and you won’t be emailed again.') };

  if (method === 'POST') {
    await addToSuppression(target.orgId, { email: target.email }, 'unsubscribe link');
    const supabase = getSupabaseAdmin();
    // ilike with wildcards escaped: a case-insensitive exact match on the address.
    const { data: optedOut } = (await supabase
      ?.from('clients')
      .update({ opted_out: true, updated_at: new Date().toISOString() })
      .eq('org_id', target.orgId)
      .ilike('email', target.email.replace(/[\\%_]/g, '\\$&'))
      .select('id')) || { data: null };
    for (const c of optedOut || []) {
      await emitCrmEvent(target.orgId, c.id, { kind: 'note', title: 'OmniReach: opted out', text: 'Clicked unsubscribe in an email — do not contact.', stage: 'opted_out' });
    }
    return { status: 200, html: page('You’re unsubscribed', `${escapeHtml(target.email)} won’t receive any more emails from us.`) };
  }

  return {
    status: 200,
    html: page(
      'Unsubscribe?',
      `Stop all emails to ${escapeHtml(target.email)}.`,
      `<form method="post"><button type="submit">Unsubscribe</button></form>`
    ),
  };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, text: string, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f5f3;color:#1b1917;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
main{background:#fff;border-radius:16px;padding:32px;max-width:420px;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#5c5650;margin:0 0 20px;line-height:1.5}
button{background:#128C7E;color:#fff;border:0;border-radius:999px;padding:10px 22px;font-size:14px;font-weight:600;cursor:pointer}</style></head>
<body><main><h1>${title}</h1><p>${text}</p>${extra}</main></body></html>`;
}
