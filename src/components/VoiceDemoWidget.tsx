import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Phone, PhoneOff, Mic, Loader2, AlertCircle } from 'lucide-react';

/** The SDK's error payloads nest the human-readable text at different depths depending on
 * the source — and for Daily errors (e.g. the "ejected" event on hang-up) `error.message` is
 * itself an object. Rendering that object as a React child crashed the whole app to a black
 * screen, so everything here is reduced to a plain string first. */
function errorText(err: any): string {
  const candidates = [
    err?.error?.message,
    err?.error?.errorMsg,
    err?.error?.msg,
    err?.error?.message?.msg,
    err?.error?.message?.errorMsg,
    err?.errorMsg,
    err?.message,
    err?.msg,
  ];
  const text = candidates.find((c) => typeof c === 'string' && c.trim());
  return (text as string | undefined)?.trim() || '';
}

/** A normal assistant-side hangup arrives as an error event — that's the call ending. */
function isCallEndedError(err: any): boolean {
  let raw = '';
  try {
    raw = JSON.stringify(err ?? '');
  } catch {
    raw = errorText(err);
  }
  return /meeting has ended|ejected|meeting ended|call has ended/i.test(raw);
}

// Browser mic errors arrive as raw DOMException text ("The request is not allowed by the user
// agent...") — translate the common ones into something a non-technical user can act on.
function friendlyCallError(err: any, fallback: string): string {
  const name = err?.name || err?.error?.name;
  const msg = errorText(err);
  if (name === 'NotAllowedError' || /not allowed|permission denied/i.test(msg)) {
    return 'Microphone access is blocked. Click the lock/site icon in the address bar and allow the microphone, and make sure your browser has microphone access in your system privacy settings (macOS: System Settings → Privacy & Security → Microphone). Then try again.';
  }
  if (name === 'NotFoundError' || /requested device not found/i.test(msg)) {
    return 'No microphone was found. Connect a microphone or headset and try again.';
  }
  if (name === 'NotReadableError' || /could not start audio source/i.test(msg)) {
    return 'Your microphone is being used by another app (Zoom, Meet, etc.). Close it and try again.';
  }
  return msg || fallback;
}

type CallState = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

interface TranscriptLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

// Fallback to the platform's shared account when an org hasn't brought its own (Channel
// Setup -> AI Voice Agent). Public key + assistant id are safe to expose client-side either
// way (Vapi's own design — the public key can only start calls with assistants you own,
// never trigger outbound PSTN calls or touch your account). This is a real WebRTC voice
// session straight from the browser to the assistant, not a phone call — no phone number,
// carrier, or international-calling plan involved, so it works regardless of Vapi plan tier.
const PLATFORM_VAPI_PUBLIC_KEY = import.meta.env.VITE_VAPI_PUBLIC_KEY as string | undefined;
const PLATFORM_VAPI_ASSISTANT_ID = import.meta.env.VITE_VAPI_ASSISTANT_ID as string | undefined;

interface VoiceDemoWidgetProps {
  publicKey?: string;
  assistantId?: string;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const VoiceDemoWidget: React.FC<VoiceDemoWidgetProps> = ({ publicKey, assistantId }) => {
  const [callState, setCallState] = useState<CallState>('idle');
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState(0);
  const vapiRef = useRef<any>(null);
  const endedByUserRef = useRef(false);
  // The previous call's transcript stays on screen until the new call's first line arrives —
  // clearing it on start collapsed the transcript box and jolted the whole page's layout.
  const clearTranscriptOnNextLineRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const VAPI_PUBLIC_KEY = publicKey || PLATFORM_VAPI_PUBLIC_KEY;
  const VAPI_ASSISTANT_ID = assistantId || PLATFORM_VAPI_ASSISTANT_ID;
  const isConfigured = Boolean(VAPI_PUBLIC_KEY && VAPI_ASSISTANT_ID);

  useEffect(() => {
    return () => {
      try {
        Promise.resolve(vapiRef.current?.stop?.()).catch(() => {});
      } catch {
        // ignore
      }
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [transcript]);

  const handleStart = async () => {
    if (!isConfigured || callState === 'connecting' || callState === 'active') return;
    setErrorMessage(null);
    clearTranscriptOnNextLineRef.current = true;
    setDurationSec(0);
    setCallState('connecting');
    endedByUserRef.current = false;
    try {
      // A previous session's instance is replaced below — stop it so its listeners can't keep
      // firing into this one.
      Promise.resolve(vapiRef.current?.stop?.()).catch(() => {});
      const { default: Vapi } = await import('@vapi-ai/web');
      const vapi = new Vapi(VAPI_PUBLIC_KEY as string);
      vapiRef.current = vapi;

      vapi.on('call-start', () => {
        setCallState('active');
        timerRef.current = setInterval(() => setDurationSec((d) => d + 1), 1000);
      });
      vapi.on('call-end', () => {
        setCallState('ended');
        setAssistantSpeaking(false);
        if (timerRef.current) clearInterval(timerRef.current);
      });
      vapi.on('speech-start', () => setAssistantSpeaking(true));
      vapi.on('speech-end', () => setAssistantSpeaking(false));
      vapi.on('error', (err: any) => {
        if (endedByUserRef.current || isCallEndedError(err)) {
          setCallState('ended');
          setAssistantSpeaking(false);
          if (timerRef.current) clearInterval(timerRef.current);
          return;
        }
        setErrorMessage(friendlyCallError(err, 'Something went wrong with the call.'));
        setCallState('error');
        if (timerRef.current) clearInterval(timerRef.current);
      });
      vapi.on('message', (message: any) => {
        if (message?.type === 'transcript' && message.transcriptType === 'final' && message.transcript) {
          const reset = clearTranscriptOnNextLineRef.current;
          clearTranscriptOnNextLineRef.current = false;
          setTranscript((prev) => [
            ...(reset ? [] : prev),
            { id: `${Date.now()}-${prev.length}`, role: message.role === 'user' ? 'user' : 'assistant', text: String(message.transcript) },
          ]);
        }
      });

      await vapi.start(VAPI_ASSISTANT_ID);
    } catch (err: any) {
      setErrorMessage(friendlyCallError(err, 'Could not start the demo call — check microphone permissions.'));
      setCallState('error');
    }
  };

  const handleStop = () => {
    endedByUserRef.current = true;
    // stop() is async and can reject while the call is tearing down — never let that surface
    // as an unhandled rejection.
    try {
      Promise.resolve(vapiRef.current?.stop?.()).catch(() => {});
    } catch {
      // ignore
    }
    setCallState('ended');
    setAssistantSpeaking(false);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const isLive = callState === 'active' || callState === 'connecting';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-r from-[#4285F4] to-[#128C7E] flex items-center justify-center text-white shrink-0">
            <Phone className="w-4.5 h-4.5" />
          </div>
          <div>
            <h3 className="font-semibold text-sm text-ink flex items-center gap-2">
              Live Voice Demo
              {callState === 'active' && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 bg-emerald-500/10 px-1.5 py-0.5 rounded-full border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  LIVE {formatDuration(durationSec)}
                </span>
              )}
            </h3>
            <p className="text-xs text-ink-muted mt-0.5 max-w-md">
              Talk to your AI Voice Agent right here in the browser — a real conversation, no
              outbound phone call and no international-calling plan required.
            </p>
          </div>
        </div>

        {isConfigured && (
          <button
            onClick={callState === 'active' ? handleStop : handleStart}
            disabled={callState === 'connecting'}
            className={`inline-flex items-center justify-center gap-2 min-w-[11rem] px-4 py-2.5 rounded-full text-sm font-semibold shadow-sm transition-colors active:scale-[0.98] shrink-0 disabled:opacity-60 disabled:cursor-not-allowed ${
              callState === 'active'
                ? 'bg-rose-500 hover:bg-rose-600 text-white'
                : 'bg-gradient-to-r from-[#4285F4] to-[#128C7E] hover:opacity-95 text-white'
            }`}
          >
            {callState === 'connecting' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Connecting…</span>
              </>
            ) : callState === 'active' ? (
              <>
                <PhoneOff className="w-4 h-4" />
                <span>End Demo Call</span>
              </>
            ) : (
              <>
                <Mic className="w-4 h-4" />
                <span>{callState === 'ended' ? 'Talk Again' : 'Start Demo Call'}</span>
              </>
            )}
          </button>
        )}
      </div>

      {!isConfigured && (
        <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span>
            Not configured yet — set <code className="bg-amber-500/15 px-1 rounded font-mono text-[10px]">VITE_VAPI_PUBLIC_KEY</code> and{' '}
            <code className="bg-amber-500/15 px-1 rounded font-mono text-[10px]">VITE_VAPI_ASSISTANT_ID</code> (from your Vapi dashboard's
            API Keys page — the Public key, not the Private one) to enable the live demo.
          </span>
        </div>
      )}

      {errorMessage && (
        <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Fixed height, always rendered: starting/ending a call only changes what's inside it.
          It used to animate open/closed (height 0 → auto), which reflowed everything below on
          every frame and made the page's many backdrop-blur panels repaint — a visible flicker
          across the whole UI. */}
      {isConfigured && (
        <div className="mt-4 h-10 flex items-center justify-center gap-2" aria-live="polite">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`w-1.5 rounded-full bg-gradient-to-t from-[#4285F4] to-[#128C7E] transition-[height,opacity] duration-300 ${
                assistantSpeaking ? 'animate-pulse' : ''
              }`}
              style={{
                height: isLive && assistantSpeaking ? `${12 + (i % 3) * 8}px` : '6px',
                opacity: isLive ? 1 : 0.35,
                animationDelay: `${i * 0.1}s`,
              }}
            />
          ))}
          <span className="text-[11px] text-ink-muted ml-2 transition-opacity duration-200">
            {callState === 'connecting'
              ? 'Connecting to your assistant…'
              : callState === 'active'
                ? assistantSpeaking
                  ? 'AI is speaking…'
                  : 'Listening…'
                : callState === 'ended'
                  ? 'Call ended'
                  : 'Ready'}
          </span>
        </div>
      )}

      {transcript.length > 0 && (
        <div className="mt-4 pt-4 border-t border-border space-y-2 max-h-64 overflow-y-auto no-scrollbar">
          {transcript.map((line) => (
            <div key={line.id} className={`flex ${line.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] px-3.5 py-2 rounded-xl text-xs whitespace-pre-line ${
                  line.role === 'user'
                    ? 'bg-surface-hover text-ink-secondary'
                    : 'bg-[#128C7E]/10 text-ink-secondary border border-[#128C7E]/20'
                }`}
              >
                {line.text}
              </div>
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>
      )}
    </motion.div>
  );
};
