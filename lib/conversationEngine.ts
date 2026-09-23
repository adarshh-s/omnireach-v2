import { GoogleGenAI } from '@google/genai';
import { generateViaGroq } from './groqClient.js';
import { getLocalTodayInfo, getTimezoneForCountry, zonedTimeToUtc } from './countryTiming.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface ConversationResult {
  reply: string;
  replySubject?: string;
  status: 'active' | 'confirmed' | 'declined' | 'handoff';
  meeting: { date: string; time: string; durationMinutes: number } | null;
  /** IANA timezone the "meeting" date/time above should be interpreted in — the lead's
   * own local timezone when their country is recognized, else null (server/UTC). Callers
   * MUST use this (via countryTiming's zonedTimeToUtc) rather than naively parsing
   * `${date}T${time}` as if it were server-local time when converting to a calendar
   * event's actual UTC instant. */
  meetingTimeZone: string | null;
}

export interface RunConversationTurnParams {
  aiClient: GoogleGenAI;
  channel?: 'whatsapp' | 'email';
  inboundSubject?: string;
  leadName?: string;
  leadCompany?: string;
  /** Used to resolve the lead's own local timezone (via countryTiming.ts) so "today" and
   * any date/time they propose or confirm are interpreted in THEIR local time, not the
   * server's UTC clock — without this, a lead confirming "3 PM" got a calendar invite for
   * 3 PM UTC, hours off from what was actually agreed. */
  leadCountry?: string;
  companyName?: string;
  senderName?: string;
  serviceDescription?: string;
  history: ConversationTurn[];
  nowIso: string;
}

const VALID_STATUSES: ConversationResult['status'][] = ['active', 'confirmed', 'declined', 'handoff'];

// gemini-flash-latest is Google's rolling alias for the current recommended flash model —
// used as a fallback so a transient outage/overload on the pinned primary model doesn't
// take the whole booking bot down.
const PRIMARY_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODEL = 'gemini-flash-latest';

// Caps how long any single provider attempt can take. Without this, a slow-but-not-yet-
// failed provider (rate-limited, degraded, or just a stalled connection) can silently eat
// the whole request budget before the loop ever reaches its next fallback — which is what
// let the webhook handler run past Vercel's 30s function ceiling and get killed outright,
// instead of degrading gracefully to Groq.
const PROVIDER_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function generateWithFallback(aiClient: GoogleGenAI, prompt: string): Promise<{ text: string }> {
  let lastErr: unknown;
  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const response = await withTimeout(
        aiClient.models.generateContent({
          model,
          contents: prompt,
          // A higher temperature than the default is deliberate here: this prompt runs once
          // per inbound message with a mostly-fixed task (agree on a call time), so a low,
          // conservative temperature made every reply converge on near-identical phrasing —
          // which read as scripted/robotic over a multi-turn conversation. Pulled back down
          // from an initial 0.85 after that setting made the model too willing to guess at
          // "confirmed" (a real calendar invite) on ambiguous wording — 0.65 keeps most of
          // the phrasing variety without the same hit to how reliably it reads intent.
          config: { responseMimeType: 'application/json', temperature: 0.65 },
        }),
        PROVIDER_TIMEOUT_MS,
        `Gemini (${model})`
      );
      return { text: response.text || '' };
    } catch (err) {
      lastErr = err;
    }
  }
  if (process.env.GROQ_API_KEY) {
    try {
      return await withTimeout(generateViaGroq(prompt), PROVIDER_TIMEOUT_MS, 'Groq');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function runConversationTurn(params: RunConversationTurnParams): Promise<ConversationResult> {
  const {
    aiClient,
    channel = 'whatsapp',
    inboundSubject,
    leadName,
    leadCompany,
    leadCountry,
    companyName,
    senderName,
    serviceDescription,
    history,
    nowIso,
  } = params;

  const now = new Date(nowIso);
  const meetingTimeZone = getTimezoneForCountry(leadCountry);
  const { label: todayLabel, dateStr: todayDateStr } = getLocalTodayInfo(now, meetingTimeZone);
  const isEmail = channel === 'email';
  // A concrete fallback so the model never has to invent a sign-off name — without this,
  // an org that hasn't filled in Settings -> senderName gets literal "[Your Name]" in
  // outbound email, since that's the model's default placeholder when none is given.
  const signOffName = senderName || companyName || 'The Team';

  const transcript = history
    .slice(-16)
    .map((h) => `${h.role === 'user' ? 'Prospect' : 'Assistant'}: ${h.text}`)
    .join('\n');

  const prompt = `You are ${senderName || 'a team member'}${companyName ? ` at ${companyName}` : ''}, personally ${isEmail ? 'emailing' : 'texting on WhatsApp with'} a prospect${leadName ? ` named ${leadName}` : ''}${leadCompany ? ` from ${leadCompany}` : ''}. You are NOT a bot playing a role — you're a real person having a real, one-off conversation, and it should read that way.

Today is ${todayLabel}${meetingTimeZone ? ` (in the prospect's own local time zone, ${meetingTimeZone})` : ''}.
${isEmail && inboundSubject ? `Email subject: "${inboundSubject}"` : ''}

Your ONLY goal: figure out if they want a short intro call, and if so, land on ONE specific date and time for it (resolve relative terms like "tomorrow" or "Thursday" against today's date), then clearly restate the confirmed date and time back to them. Any date/time you propose or confirm — including "meeting.date"/"meeting.time" in the JSON below — is always in the prospect's own local time${meetingTimeZone ? ` (${meetingTimeZone})` : ''}, never yours.
${serviceDescription ? `What we offer: ${serviceDescription}` : ''}

Conversation so far:
${transcript}

HOW TO SOUND HUMAN, NOT SCRIPTED:
- Read the "Assistant" turns above first. Whatever words, sentence shapes, or phrasing you used before, do NOT reuse them — say it a genuinely different way this time, the way a real person naturally varies how they talk instead of repeating a script.
- React to what the prospect *actually just said* before anything else — one short, specific acknowledgment (not a generic "Thanks for reaching out!" every time). If they said something short like "ok" or "sure" or just a time, don't re-explain the whole pitch again — just move forward naturally, like a real text thread does.
- ${isEmail ? 'Write like a real, brief email a busy person sends from their phone — not a marketing template.' : 'Write like an actual WhatsApp text: short, casual, contractions ("that works", "sounds good", "no worries"), occasionally starting mid-thought. No corporate phrases like "I hope this message finds you well," "circle back," "touch base," or "reaching out."'}
- DO NOT PRESSURE THEM. If the prospect says something like "let me check my calendar," "I'll get back to you," "give me a moment," or anything else that means "I need time" — a real person's reply is short and gracious ("Sounds good, whenever works!" / "No problem, take your time.") and offers NO new times, NO fresh options, no nudge. Do not propose additional dates just because a reply is due — that reads as pushy, not helpful. Only bring up scheduling again if THEY bring it back up, or if they explicitly say the offered times don't work.
- Never repeat the same call-to-action wording twice in a row. If you already proposed times and they've engaged but haven't picked one yet, don't just repeat the identical offer — nudge differently. But per the rule above, if they said they'd get back to you, don't nudge at all — wait.
- Vary sentence length and structure turn to turn. Don't open every reply with the same kind of sentence.
- ${
    isEmail
      ? `Keep it concise (under 120 words), warm, and genuinely personal-sounding, with a real greeting and sign-off. Sign off with exactly "${signOffName}" — never a placeholder like "[Your Name]".`
      : 'Keep it under 50 words. Sound like a text message, not an email crammed into a chat box.'
  }
- Never invent facts you weren't given, and never output bracket placeholders (e.g. "[Your Name]", "[Company]") — use the concrete names given above, or omit that detail entirely.

Reply to the prospect's latest message. Output STRICT JSON only, no markdown, no commentary:
{
  "reply": "your ${isEmail ? 'email body' : 'WhatsApp reply'} text"${isEmail ? ',\n  "replySubject": "a short reply subject line, e.g. \\"Re: quick intro call\\""' : ''},
  "status": "active" | "confirmed" | "declined" | "handoff",
  "meeting": { "date": "YYYY-MM-DD", "time": "HH:MM", "durationMinutes": 30 } or null
}

Rules:
- "confirmed" is a HIGH-STAKES decision — a real calendar invite gets created the instant you set this, so treat it like locking in a real appointment, not like guessing the likely outcome. Set it ONLY when the prospect's MOST RECENT message contains unambiguous, explicit agreement to ONE specific date and time that was already on the table (e.g. "yes, Thursday 10am works", "Friday works for me", "let's do the 3pm one", or them simply naming one of the times you offered). If their latest message is anything else — asking a question back to you (e.g. "is that ok for you?" is THEM asking YOU, not them agreeing), saying they'll check and reply later, silence on the time and talking about something else, a vague "ok"/"sounds good" with no time actually named — that is NOT a confirmation. When genuinely unsure whether they confirmed, do NOT confirm — ask them to explicitly confirm the exact time instead ("active" status), rather than guessing and booking it.
- If you notice from the conversation above that a meeting was confirmed earlier but the prospect's latest message now disputes it, says they didn't agree to that, or asks to change/cancel it — apologize briefly for the mix-up, treat the earlier meeting as no longer booked (status "active", meeting null so it can be cancelled), and restart finding a time that actually works. Don't just ignore what they said and move on to unrelated new options.
- "declined": they're not interested or asked to stop contacting them.
- "handoff": they're asking something you can't answer confidently (exact pricing, technical detail, contract terms) or explicitly ask for a human — reply that a team member will follow up shortly.
- "active": still gathering info, waiting on them, or proposing time options.
- When proposing times for the first time, offer 1-2 concrete options (e.g. "would tomorrow 3 PM or Thursday 11 AM work?") instead of an open-ended "when works for you?". Only offer a fresh pair of times if they said the current ones don't work — otherwise see the pressure rule above.
- "meeting.date" must be ${todayDateStr} or a later date. "meeting.time" must be 24-hour HH:MM.`;

  const response = await generateWithFallback(aiClient, prompt);

  try {
    const parsed = JSON.parse(response.text || '{}');
    const status: ConversationResult['status'] = VALID_STATUSES.includes(parsed.status) ? parsed.status : 'active';

    let meeting: ConversationResult['meeting'] = null;
    if (status === 'confirmed' && parsed.meeting?.date && parsed.meeting?.time) {
      // The AI was told this date/time is in the prospect's own local time zone — validate
      // "is this actually in the future" the same way, via zonedTimeToUtc, rather than
      // naively parsing it as server-local (which is UTC on Vercel and would wrongly
      // reject/accept times depending on the gap between the two zones).
      const [hh, mm] = String(parsed.meeting.time).split(':').map(Number);
      const [yy, mo, dd] = String(parsed.meeting.date).split('-').map(Number);
      const candidate =
        meetingTimeZone && yy && mo && dd && !isNaN(hh) && !isNaN(mm)
          ? zonedTimeToUtc(yy, mo, dd, hh, mm, meetingTimeZone)
          : new Date(`${parsed.meeting.date}T${parsed.meeting.time}:00`);
      const isValidFutureDate = !isNaN(candidate.getTime()) && candidate.getTime() > now.getTime() - 5 * 60000;
      if (isValidFutureDate) {
        meeting = {
          date: parsed.meeting.date,
          time: parsed.meeting.time,
          durationMinutes: Number(parsed.meeting.durationMinutes) > 0 ? Number(parsed.meeting.durationMinutes) : 30,
        };
      }
    }

    return {
      reply: parsed.reply || "Thanks for your message! Could you tell me a bit more?",
      replySubject: isEmail ? parsed.replySubject || (inboundSubject ? `Re: ${inboundSubject}` : 'Re: your inquiry') : undefined,
      status: meeting || status !== 'confirmed' ? status : 'active',
      meeting,
      meetingTimeZone,
    };
  } catch {
    return {
      reply: isEmail ? 'Sorry, could you clarify that? Want to make sure I get the details right.' : 'Sorry, could you say that again? Want to make sure I get the details right.',
      replySubject: isEmail ? (inboundSubject ? `Re: ${inboundSubject}` : 'Re: your inquiry') : undefined,
      status: 'active',
      meetingTimeZone,
      meeting: null,
    };
  }
}
