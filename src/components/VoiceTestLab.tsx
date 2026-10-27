import React, { useEffect, useRef, useState } from 'react';
import { Mic, PhoneOff, Loader2, AlertCircle, GraduationCap, Trash2, Info } from 'lucide-react';
import { PageHeader } from './PageHeader';
import { friendlyCallError, isCallEndedError } from './VoiceDemoWidget';

interface VoiceTestLabProps {
  accessToken?: string | null;
  /** Opens Channel Setup at the Voice Agent section. */
  onOpenVoiceSetup?: () => void;
}

type CallState = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

interface Line {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface Lesson {
  id: string;
  lesson: string;
  channel: string;
  status: string;
  source: string;
}

const card = 'bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl shadow-card';
const input =
  'w-full px-3 py-2 bg-canvas border border-border rounded-xl text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-[#128C7E]/30';

const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * Talk to your own voice agent from the browser, set up exactly like a real call, and teach
 * it as you go: each correction becomes a voice lesson (lib/aiLearning.ts) that the next call
 * — test or real — uses. Test calls never book real meetings or touch the do-not-contact list
 * (lib/voiceTest.ts).
 */
export const VoiceTestLab: React.FC<VoiceTestLabProps> = ({ accessToken, onOpenVoiceSetup }) => {
  const [persona, setPersona] = useState({ name: 'Alex', company: '', country: '', email: '' });
  const [callState, setCallState] = useState<CallState>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [info, setInfo] = useState<{ toolsAvailable: boolean; language: string | null } | null>(null);
  const [lesson, setLesson] = useState('');
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [savingLesson, setSavingLesson] = useState(false);
  const [lessonNote, setLessonNote] = useState<string | null>(null);
  const vapiRef = useRef<any>(null);
  const endedByUser = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };

  const loadLessons = () => {
    if (!accessToken) return;
    fetch('/api/conversations?action=learning', { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLessons((d?.lessons || []).filter((l: Lesson) => l.status === 'active' && (l.channel === 'voice' || l.channel === 'all'))))
      .catch(() => setLessons([]));
  };

  useEffect(() => {
    loadLessons();
    return () => {
      try {
        Promise.resolve(vapiRef.current?.stop?.()).catch(() => {});
      } catch {
        // ignore
      }
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [lines]);

  const stopTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const start = async () => {
    if (!accessToken || callState === 'connecting' || callState === 'active') return;
    setError(null);
    setLines([]);
    setSeconds(0);
    setCallState('connecting');
    endedByUser.current = false;
    try {
      const res = await fetch('/api/voice/vapi?action=test-config', { method: 'POST', headers: authHeaders, body: JSON.stringify({ persona }) });
      const config = await res.json().catch(() => ({}));
      if (!res.ok || !config.ok) throw new Error(config?.error || 'Could not set up the test call.');
      setInfo({ toolsAvailable: !!config.toolsAvailable, language: config.language });

      Promise.resolve(vapiRef.current?.stop?.()).catch(() => {});
      const { default: Vapi } = await import('@vapi-ai/web');
      const vapi = new Vapi(config.publicKey);
      vapiRef.current = vapi;
      vapi.on('call-start', () => {
        setCallState('active');
        timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      });
      vapi.on('call-end', () => {
        setCallState('ended');
        setSpeaking(false);
        stopTimer();
      });
      vapi.on('speech-start', () => setSpeaking(true));
      vapi.on('speech-end', () => setSpeaking(false));
      vapi.on('error', (err: any) => {
        setSpeaking(false);
        stopTimer();
        if (endedByUser.current || isCallEndedError(err)) return setCallState('ended');
        setError(friendlyCallError(err, 'Something went wrong with the test call.'));
        setCallState('error');
      });
      vapi.on('message', (m: any) => {
        if (m?.type === 'transcript' && m.transcriptType === 'final' && m.transcript) {
          setLines((prev) => [...prev, { id: `${Date.now()}-${prev.length}`, role: m.role === 'user' ? 'user' : 'assistant', text: String(m.transcript) }]);
        }
      });
      await vapi.start(config.assistantId, config.assistantOverrides);
    } catch (err: any) {
      setError(friendlyCallError(err, err?.message || 'Could not start the test call.'));
      setCallState('error');
    }
  };

  const stop = () => {
    endedByUser.current = true;
    try {
      Promise.resolve(vapiRef.current?.stop?.()).catch(() => {});
    } catch {
      // ignore
    }
    setCallState('ended');
    setSpeaking(false);
    stopTimer();
  };

  const saveLesson = async () => {
    const text = lesson.trim();
    if (text.length < 5) return;
    setSavingLesson(true);
    setLessonNote(null);
    try {
      const res = await fetch('/api/conversations?action=learning', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ op: 'add', channel: 'voice', lesson: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.error || 'Could not save that.');
      setLesson('');
      setLessonNote('Saved — the agent uses it from the next call. Start another test to hear the difference.');
      loadLessons();
    } catch (err: any) {
      setLessonNote(err?.message || 'Could not save that.');
    } finally {
      setSavingLesson(false);
    }
  };

  const removeLesson = async (id: string) => {
    await fetch('/api/conversations?action=learning', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ op: 'set-status', id, status: 'archived' }),
    }).catch(() => {});
    loadLessons();
  };

  const live = callState === 'connecting' || callState === 'active';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Test Voice Agent"
        description="Talk to your AI voice agent from the browser — set up exactly like a real call — and teach it what to do better."
      />

      {!accessToken && <div className={`${card} p-6 text-sm text-ink-muted`}>Sign in to a workspace to test your voice agent.</div>}

      {accessToken && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3 space-y-4">
            <section className={`${card} p-5 space-y-4`}>
              <div>
                <h2 className="text-sm font-semibold text-ink">You're playing the lead</h2>
                <p className="text-[11px] text-ink-muted">The agent treats you as this person — their country sets the time zone it books in.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(
                  [
                    ['name', 'Name', 'Alex'],
                    ['company', 'Company', 'Bright Dental'],
                    ['country', 'Country', 'United Arab Emirates'],
                    ['email', 'Email (for the invite)', 'alex@example.com'],
                  ] as const
                ).map(([key, label, placeholder]) => (
                  <label key={key} className="block">
                    <span className="block text-xs font-medium text-ink-secondary mb-1">{label}</span>
                    <input
                      value={persona[key]}
                      disabled={live}
                      onChange={(e) => setPersona({ ...persona, [key]: e.target.value })}
                      placeholder={placeholder}
                      className={`${input} disabled:opacity-60`}
                    />
                  </label>
                ))}
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                {!live ? (
                  <button
                    onClick={start}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-strong hover:bg-[#0d6e62] text-white text-sm font-semibold shadow-sm"
                  >
                    <Mic className="w-4 h-4" />
                    {callState === 'ended' ? 'Test again' : 'Start test call'}
                  </button>
                ) : (
                  <button
                    onClick={stop}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-rose-500/80 hover:bg-rose-500 text-white text-sm font-semibold"
                  >
                    {callState === 'connecting' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PhoneOff className="w-4 h-4" />}
                    {callState === 'connecting' ? 'Connecting…' : 'End call'}
                  </button>
                )}
                {callState === 'active' && (
                  <span className="text-xs text-ink-secondary tabular-nums flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${speaking ? 'bg-[#25D366] animate-pulse' : 'bg-ink-muted'}`} />
                    {speaking ? 'Agent speaking' : 'Listening'} · {formatDuration(seconds)}
                  </span>
                )}
                {callState === 'ended' && <span className="text-xs text-ink-muted">Call ended · {formatDuration(seconds)}</span>}
              </div>

              {error && (
                <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2 flex gap-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  {error}
                </p>
              )}
              {info && !info.toolsAvailable && (
                <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  Running locally: the agent's voice, language and instructions are live, but booking and "don't call me" only work on the deployed app (the voice provider can't reach this computer).
                </p>
              )}
              <p className="text-[11px] text-ink-muted flex gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>
                  Test calls use your real voice, language and rules{info?.language ? ` (${info.language})` : ''}, but never book real meetings or add anyone to do-not-contact. Minutes count towards your usage.{' '}
                  {onOpenVoiceSetup && (
                    <button onClick={onOpenVoiceSetup} className="underline text-ink-secondary">
                      Change voice, language or prompt
                    </button>
                  )}
                </span>
              </p>
            </section>

            <section className={`${card} p-5`}>
              <h2 className="text-sm font-semibold text-ink mb-3">Conversation</h2>
              <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {lines.length === 0 ? (
                  <p className="text-xs text-ink-muted">
                    {live ? 'Say hello — the transcript appears here as you talk.' : 'Start a test call and talk to the agent through your microphone.'}
                  </p>
                ) : (
                  lines.map((l) => (
                    <div key={l.id} className={`flex ${l.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                      <div
                        className={`max-w-[80%] px-3.5 py-2 rounded-2xl text-xs leading-relaxed ${
                          l.role === 'user' ? 'bg-surface border border-border text-ink' : 'bg-[#25D366]/10 border border-[#25D366]/30 text-emerald-300'
                        }`}
                      >
                        {l.text}
                      </div>
                    </div>
                  ))
                )}
                <div ref={endRef} />
              </div>
            </section>
          </div>

          <div className="lg:col-span-2 space-y-4">
            <section className={`${card} p-5 space-y-3`}>
              <div className="flex items-center gap-2">
                <GraduationCap className="w-4 h-4 text-[#128C7E]" />
                <h2 className="text-sm font-semibold text-ink">Teach the agent</h2>
              </div>
              <p className="text-[11px] text-ink-muted">
                Heard something you'd change? Write it as an instruction. It's added to every call from now on — tests and real ones.
              </p>
              <textarea
                rows={4}
                value={lesson}
                maxLength={300}
                onChange={(e) => setLesson(e.target.value)}
                placeholder={'e.g. Keep answers to one or two sentences.\ne.g. When asked about price, say plans start at 499 a month and offer a call with the team.'}
                className={`${input} resize-none text-xs`}
              />
              <button
                onClick={saveLesson}
                disabled={savingLesson || lesson.trim().length < 5}
                className="w-full inline-flex items-center justify-center gap-2 py-2 rounded-xl bg-brand-strong hover:bg-[#0d6e62] text-white text-xs font-semibold disabled:opacity-40"
              >
                {savingLesson && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save instruction
              </button>
              {lessonNote && <p className="text-[11px] text-ink-secondary">{lessonNote}</p>}
            </section>

            <section className={`${card} p-5`}>
              <h2 className="text-sm font-semibold text-ink mb-1">What the agent has learned</h2>
              <p className="text-[11px] text-ink-muted mb-3">Instructions it follows on calls, yours and the ones it learned from real conversations.</p>
              {lessons === null ? (
                <p className="text-xs text-ink-muted">
                  <Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1.5" />
                  Loading…
                </p>
              ) : lessons.length === 0 ? (
                <p className="text-xs text-ink-muted">Nothing yet.</p>
              ) : (
                <ul className="space-y-2">
                  {lessons.map((l) => (
                    <li key={l.id} className="flex items-start gap-2 text-xs text-ink bg-canvas border border-border rounded-xl px-3 py-2">
                      <span className="flex-1">{l.lesson}</span>
                      <button onClick={() => removeLesson(l.id)} className="text-ink-muted hover:text-rose-400 shrink-0" title="Remove">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
