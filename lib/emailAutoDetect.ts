/**
 * Tells a real reply apart from mail no person wrote, before the AI booking bot answers
 * (lib/emailWebhookHandler.ts):
 *   - bounce: the address doesn't exist / the mailbox rejected the email (delivery status
 *     notifications from MAILER-DAEMON, postmaster, Outlook's "Undeliverable", etc.). The
 *     address is put on the do-not-contact list — sending to dead addresses again is what
 *     gets a sending domain flagged as spam.
 *   - auto_reply: out-of-office, vacation responders, "we received your message" tickets.
 *     Logged on the conversation, but not counted as a reply, never answered by the AI (two
 *     auto-responders would answer each other forever) and the follow-up still goes out.
 *
 * Headers are the reliable signal (RFC 3834 Auto-Submitted, Exchange's X-Auto-Response-Suppress,
 * a multipart/report content type); subject and sender patterns cover mail systems that
 * don't set them, in the languages OmniReach launches in.
 */

export type InboundEmailKind = 'human' | 'bounce' | 'auto_reply';

export interface InboundEmailClassification {
  kind: InboundEmailKind;
  reason: string;
}

/** Raw header block ("Name: value" lines, folded lines allowed) → lowercased name → value. */
export function parseHeaderBlock(raw: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    out[name] = out[name] ? `${out[name]}, ${value}` : value;
  }
  return out;
}

const BOUNCE_SENDER = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon|bounce[s]?|no-?reply-?bounce)@/i;
const BOUNCE_SUBJECT = new RegExp(
  [
    'undeliverable',
    'undelivered mail',
    'delivery status notification \\((failure|delay)\\)',
    'delivery (has )?failed',
    'delivery failure',
    'mail delivery (failed|failure|system|subsystem)',
    'returned mail',
    'failure notice',
    'message not delivered',
    'could not be delivered',
    'address not found',
    'non ?remis', // fr
    'unzustellbar', // de
    'nicht zugestellt',
    'no se pudo entregar', // es
    'non recapitabile', // it
    'onbestelbaar', // nl
    'não entregue', // pt
  ].join('|'),
  'i'
);

const AUTO_SUBJECT = new RegExp(
  [
    'auto(matic)?[- ]?(reply|response|antwort)',
    'out of (the )?office',
    '\\booo\\b',
    'on vacation',
    'on leave',
    'away from (the )?office',
    'currently away',
    'we (have )?received your (email|message|request)',
    'ticket (#|received|created)',
    'abwesenheit', // de
    'automatische antwort',
    'réponse automatique', // fr
    'absent du bureau',
    'respuesta automática', // es
    'fuera de la oficina',
    'risposta automatica', // it
    'fuori ufficio',
    'automatisch antwoord', // nl
    'afwezig',
    'resposta automática', // pt
    'ausente do escritório',
    'autosvar', // sv/da/no
    'automaattinen vastaus', // fi
    'odpowiedź automatyczna', // pl
    'स्वचालित उत्तर', // hi
    'कार्यालय से बाहर',
  ].join('|'),
  'i'
);

const DELAY = /\b(delay(ed)?|will (continue to )?retry|still trying|warning: message|temporar(y|ily))\b|Action:\s*delayed/i;
const HARD_FAILURE = /\b(5\.\d\.\d+|550|551|552|553|554|user unknown|does not exist|no such user|mailbox (unavailable|not found)|recipient (address )?rejected)\b|Action:\s*failed/i;

export function classifyInboundEmail(fields: { from?: string; subject?: string; headers?: string; text?: string }): InboundEmailClassification {
  const headers = parseHeaderBlock(fields.headers);
  const from = (fields.from || '').match(/<([^>]+)>/)?.[1] || fields.from || '';
  const subject = fields.subject || '';
  const contentType = (headers['content-type'] || '').toLowerCase();

  // Bounces first — some also carry Auto-Submitted: auto-replied. A "still trying" delay
  // notice is ignored like an auto-reply: the address may well work.
  const isReport = (contentType.includes('multipart/report') && contentType.includes('delivery-status')) || BOUNCE_SENDER.test(from.trim());
  if (isReport && DELAY.test(`${subject}\n${(fields.text || '').slice(0, 3000)}`) && !HARD_FAILURE.test(fields.text || '')) {
    return { kind: 'auto_reply', reason: 'delivery delayed (will retry)' };
  }
  if (contentType.includes('multipart/report') && contentType.includes('delivery-status')) return { kind: 'bounce', reason: 'delivery status report' };
  if (BOUNCE_SENDER.test(from.trim())) return { kind: 'bounce', reason: `sent by ${from.trim().toLowerCase()}` };
  if (headers['x-failed-recipients']) return { kind: 'bounce', reason: 'X-Failed-Recipients header' };
  if (BOUNCE_SUBJECT.test(subject) && HARD_FAILURE.test(fields.text || '')) {
    return { kind: 'bounce', reason: `subject "${subject.slice(0, 80)}"` };
  }

  const autoSubmitted = (headers['auto-submitted'] || '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return { kind: 'auto_reply', reason: `Auto-Submitted: ${autoSubmitted}` };
  if (headers['x-autoreply'] || headers['x-autorespond'] || headers['x-autoresponder']) return { kind: 'auto_reply', reason: 'auto-responder header' };
  const suppress = (headers['x-auto-response-suppress'] || '').toLowerCase();
  if (/\b(all|oof|autoreply)\b/.test(suppress) && AUTO_SUBJECT.test(subject)) return { kind: 'auto_reply', reason: 'Exchange automatic reply' };
  const precedence = (headers['precedence'] || '').toLowerCase();
  if (precedence === 'auto_reply') return { kind: 'auto_reply', reason: 'Precedence: auto_reply' };
  if (AUTO_SUBJECT.test(subject)) return { kind: 'auto_reply', reason: `subject "${subject.slice(0, 80)}"` };
  // Bulk/list mail into a reply-tracking address isn't a person answering either.
  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'list') return { kind: 'auto_reply', reason: `Precedence: ${precedence}` };

  return { kind: 'human', reason: '' };
}

/** "Back on Monday 3 November" style hint from an out-of-office, for the AI Inbox. */
export function autoReplySummary(subject: string | undefined, text: string | undefined): string {
  const body = (text || '').replace(/\s+/g, ' ').trim();
  const back = body.match(/[^.]*\b(back|return(ing)?|zurück|de retour|de vuelta|di ritorno|terug|वापस)\b[^.]*\./i)?.[0];
  return (back || subject || body).trim().slice(0, 200);
}
