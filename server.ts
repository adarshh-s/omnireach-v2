import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Local dev only — Vercel injects its own env vars in production. Loads server-only
// secrets (SUPABASE_SERVICE_ROLE_KEY, WHATSAPP_VERIFY_TOKEN, CRON_SECRET, etc.) from
// .env.local into process.env; Vite separately auto-loads VITE_-prefixed vars for the
// client bundle, so this only needs to cover the non-VITE_ server-side half.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env.local'), quiet: true });

import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import {
  verifyWhatsAppWebhook,
  verifyWhatsAppSignature,
  resolveWhatsAppSignatureSecret,
  processWhatsAppWebhookPayload,
} from './lib/whatsappWebhookHandler';
import { getSupabaseAdmin } from './lib/supabaseAdmin';
import { getOrgIdFromAuthHeader } from './lib/supabaseServerAuth';
import { parseMultipartFields } from './lib/parseMultipart';
import { verifyEmailWebhookToken, processInboundEmail } from './lib/emailWebhookHandler';
import { reconcileStaleVoiceCalls } from './lib/voiceCalls';
import { buildLearnedGuidance, handleLearningRequest } from './lib/aiLearning';
import sendWhatsAppHandler from './api/outreach/send-whatsapp';
import generateMessageHandler from './api/outreach/generate-message';
import sendEmailHandler from './api/outreach/send-email';
import subscribeAppHandler from './api/whatsapp/subscribe-app';
import oauthConnectHandler from './api/auth/google/connect';
import oauthCallbackHandler from './api/auth/google/callback';
import vapiHandler from './api/voice/vapi';
import dispatchScheduledHandler from './api/cron/dispatch-scheduled';
import emailInboundHandler from './api/email/inbound';
import conversationsHandler from './api/conversations';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
app.disable('x-powered-by');

// Same security headers as vercel.json, for when this server runs the app (npm start).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), microphone=(self)');
  next();
});

app.use(
  express.json({
    limit: '10mb',
    // Preserves the exact raw bytes alongside the parsed body — needed to verify Meta's
    // X-Hub-Signature-256 HMAC on the WhatsApp webhook route, which must be computed over
    // the untouched wire bytes, not a re-serialized JSON.stringify of the parsed object.
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);


// Initialize Gemini Client
let aiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

app.post('/api/outreach/generate-message', (req, res) => generateMessageHandler(req as any, res as any));

app.post('/api/ai/auto-reply', async (req, res) => {
  try {
    const { incomingMessage, lead, settings } = req.body;
    const ai = getGenAI();

    const clientName = lead?.name || 'there';
    const firstName = clientName.split(' ')[0];
    const companyName = settings?.companyName || 'our company';

    if (ai && incomingMessage) {
      const learnedGuidance = await buildLearnedGuidance(await getOrgIdFromAuthHeader(req.headers.authorization), ['whatsapp', 'email']);
      const prompt = `A client named ${clientName} at company ${lead?.company || 'their firm'} replied to our outreach with:
"${incomingMessage}"

Our company: ${companyName}
Our value prop: ${settings?.serviceDescription || 'AI outreach and calendar booking automation'}

There is no booking link or scheduling page. Generate a concise, helpful, polite, and
persuasive response (under 75 words).
- If they are interested or asking for times: ask them to reply with a day/time that works for them so it can be confirmed directly on the calendar.
- If they ask about pricing or features: answer positively with general context and invite them to reply with a day/time for a quick call.
- If they say not interested or unsubscribe: acknowledge politely and confirm they are opted out.
${learnedGuidance ? `\n${learnedGuidance}\n` : ''}
Return strict JSON:
{
  "reply": "The response message text"
}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.7-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });

      try {
        const parsed = JSON.parse(response.text || '{}');
        if (parsed.reply) {
          return res.json({ reply: parsed.reply });
        }
      } catch {}
    }

    const lower = (incomingMessage || '').toLowerCase();
    if (lower.includes('price') || lower.includes('cost')) {
      return res.json({
        reply: `Our pricing scales flexibly with your contact volume. We'd love to show you a quick breakdown for ${lead?.company || 'your team'} on a 10-minute call — just reply with a day/time that works!`,
      });
    }

    if (lower.includes('yes') || lower.includes('sure') || lower.includes('demo')) {
      return res.json({
        reply: `Awesome, ${firstName}! Just reply with a day/time that works for you and I'll get it on the calendar. Looking forward to connecting!`,
      });
    }

    return res.json({
      reply: `Thanks for the response, ${firstName}! Would Thursday at 11:00 AM or Friday at 3:00 PM work for a quick walk-through? Or just reply with a time that suits you better.`,
    });
  } catch (err) {
    console.error('Error in /api/ai/auto-reply:', err);
    res.status(500).json({ error: 'Failed to generate auto-reply' });
  }
});

// The routes below call the same handlers Vercel runs (api/**), so local dev can't drift
// from production. Express's req/res cover the small subset of the API those handlers use.
app.all('/api/outreach/send-whatsapp', (req, res) => sendWhatsAppHandler(req as any, res as any));
app.post('/api/outreach/send-email', (req, res) => sendEmailHandler(req as any, res as any));
app.all('/api/whatsapp/subscribe-app', (req, res) => subscribeAppHandler(req as any, res as any));

// WhatsApp Webhook Verification — Meta calls this once when you register the webhook URL
app.get('/api/whatsapp/webhook', (req, res) => {
  const result = verifyWhatsAppWebhook(req.query as Record<string, unknown>);
  if (result) {
    res.status(200).send(result.challenge);
  } else {
    res.sendStatus(403);
  }
});

// WhatsApp Webhook Receiver — incoming prospect replies, handled by the AI booking bot
app.post('/api/whatsapp/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const secret = await resolveWhatsAppSignatureSecret((req as any).rawBody || '');
    if (!verifyWhatsAppSignature((req as any).rawBody || '', signature, secret)) {
      console.warn('[WhatsApp Webhook] Signature verification failed — rejecting payload.');
      return res.sendStatus(403);
    }
    await processWhatsAppWebhookPayload(req.body);
  } catch (err) {
    console.error('[WhatsApp Webhook] Processing error:', err);
  }
  res.sendStatus(200);
});

// Email Webhook Receiver — SendGrid Inbound Parse posts replies as multipart/form-data;
// our own Cloudflare Email Worker (see cloudflare/email-worker/) posts JSON instead.
// Configure the Destination URL as: https://<domain>/api/email/inbound?token=<EMAIL_INBOUND_WEBHOOK_SECRET>
app.all('/api/email/inbound', (req, res, next) =>
  req.query.action === 'unsubscribe' || req.query.action === 'resend-events' ? emailInboundHandler(req as any, res as any) : next()
);
app.post('/api/email/inbound', async (req, res) => {
  if (!verifyEmailWebhookToken(req.query.token as string | undefined)) {
    return res.sendStatus(403);
  }
  try {
    const contentType = req.headers['content-type'] || '';
    let fields: Record<string, string>;
    if (contentType.includes('application/json')) {
      // express.json() middleware already parsed this into req.body (and drained the stream).
      const body = req.body || {};
      fields = {};
      for (const key of ['to', 'from', 'subject', 'text', 'html', 'headers']) {
        if (typeof body[key] === 'string') fields[key] = body[key];
      }
    } else {
      fields = await parseMultipartFields(req);
    }
    await processInboundEmail(fields);
  } catch (err) {
    console.error('[Email Webhook] Processing error:', err);
  }
  res.sendStatus(200);
});

// Scheduled dispatcher — the same handler Vercel's cron runs (campaign sends, retries, AI call follow-ups).
app.get('/api/cron/dispatch-scheduled', (req, res) => dispatchScheduledHandler(req as any, res as any));

app.all('/api/conversations', (req, res, next) =>
  req.query.action === 'analytics' || req.query.action === 'inbox' ? conversationsHandler(req as any, res as any) : next()
);
app.all('/api/conversations', async (req, res, next) => {
  if (req.query.action !== 'learning') return next();
  const orgId = await getOrgIdFromAuthHeader(req.headers.authorization);
  if (!orgId) return res.status(401).json({ error: 'Sign in required.' });
  const result = await handleLearningRequest(orgId, req.method, req.body);
  res.status(result.httpStatus).json(result.body);
});

// API Route: List live AI bot conversations for the signed-in org (for the "AI Inbox" UI
// panel) — one route for every channel (?channel=whatsapp|email|voice), mirroring api/conversations.ts.
app.get('/api/conversations', async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.json({ configured: false, conversations: [] });
  }
  const orgId = await getOrgIdFromAuthHeader(req.headers.authorization);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }
  const table =
    req.query.channel === 'email' ? 'email_conversations' : req.query.channel === 'voice' ? 'voice_calls' : 'whatsapp_conversations';
  const query = () =>
    supabase.from(table).select('*').eq('org_id', orgId).order('last_message_at', { ascending: false }).limit(200);
  let { data, error } = await query();
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  if (table === 'voice_calls' && (await reconcileStaleVoiceCalls(orgId, data || []))) {
    ({ data, error } = await query());
    if (error) return res.status(500).json({ error: error.message });
  }
  res.json({ configured: true, conversations: data });
});

// Google and Outlook connect/callback (calendar and email sending). Vercel reaches the
// Microsoft paths through vercel.json rewrites adding ?provider=microsoft; Express adds it here.
const asMicrosoft = (req: express.Request) => {
  (req.query as Record<string, unknown>).provider = 'microsoft';
  return req as any;
};
app.post('/api/auth/google/connect', (req, res) => oauthConnectHandler(req as any, res as any));
app.get('/api/auth/google/callback', (req, res) => oauthCallbackHandler(req as any, res as any));
app.post('/api/auth/microsoft/connect', (req, res) => oauthConnectHandler(asMicrosoft(req), res as any));
app.get('/api/auth/microsoft/callback', (req, res) => oauthCallbackHandler(asMicrosoft(req), res as any));
app.get('/api/auth/crm/callback', (req, res) => oauthCallbackHandler(req as any, res as any));

// Vapi voice calling — trigger a call, Vapi's webhook (incl. inbound calls), assistant prompt sync.
app.all('/api/voice/vapi', (req, res) => vapiHandler(req as any, res as any));

// Health Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    mode: 'whatsapp_email_outreach',
    timestamp: new Date().toISOString(),
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
