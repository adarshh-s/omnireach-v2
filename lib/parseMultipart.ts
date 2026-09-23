import Busboy from 'busboy';
import type { IncomingMessage } from 'http';

/**
 * Parses a multipart/form-data request body into plain string fields. SendGrid's Inbound
 * Parse webhook always POSTs as multipart/form-data (from, to, subject, text, html, etc.
 * as individual fields) — never JSON — so this is required to read it.
 *
 * Must be called before anything else consumes the request stream (e.g. Express's
 * express.json() middleware skips non-JSON content types and leaves the stream untouched,
 * so this is safe to call from a route handler as-is).
 */
export function parseMultipartFields(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      resolve({});
      return;
    }

    const busboy = Busboy({ headers: { 'content-type': contentType } });
    const fields: Record<string, string> = {};

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });
    busboy.on('file', (_name, file) => {
      file.resume(); // discard any attachments — not handled in this pass
    });
    busboy.on('close', () => resolve(fields));
    busboy.on('error', reject);

    req.pipe(busboy);
  });
}

export function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Parses a JSON request body into the same {to, from, subject, text} field shape as
 * parseMultipartFields — used by our own Cloudflare Email Worker (see cloudflare/email-worker.js),
 * which forwards inbound mail as JSON instead of SendGrid's multipart/form-data.
 */
async function parseJsonFields(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readRawBody(req);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    const fields: Record<string, string> = {};
    for (const key of ['to', 'from', 'subject', 'text', 'html']) {
      if (typeof data[key] === 'string') fields[key] = data[key];
    }
    return fields;
  } catch {
    return {};
  }
}

/** Dispatches to the right parser based on Content-Type — accepts both SendGrid's
 * multipart/form-data and our own Cloudflare Email Worker's application/json. */
export function parseInboundEmailFields(req: IncomingMessage): Promise<Record<string, string>> {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) return parseJsonFields(req);
  return parseMultipartFields(req);
}
