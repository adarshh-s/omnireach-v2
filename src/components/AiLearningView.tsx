import { PageHeader, headerSecondaryButton } from './PageHeader';
import React, { useEffect, useRef, useState } from 'react';
import {
  RefreshCw,
  Check,
  X,
  Archive,
  RotateCcw,
  Pencil,
  Plus,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
} from 'lucide-react';
import { CampaignSettings } from '../types';

type LessonChannel = 'all' | 'whatsapp' | 'email' | 'voice';
type LearningMode = 'off' | 'review' | 'auto';

interface Lesson {
  id: string;
  channel: LessonChannel;
  lesson: string;
  rationale: string | null;
  status: 'suggested' | 'active' | 'rejected' | 'archived';
  source: 'ai' | 'manual';
  evidence_count: number;
  retire_reason: string | null;
  updated_at: string;
}

interface AiLearningViewProps {
  accessToken?: string | null;
  campaignSettings: CampaignSettings;
  onUpdateSettings: (settings: CampaignSettings) => void;
}

const CHANNEL_LABELS: Record<LessonChannel, string> = {
  all: 'All channels',
  whatsapp: 'WhatsApp',
  email: 'Email',
  voice: 'Voice',
};

const CHANNEL_STYLES: Record<LessonChannel, string> = {
  all: 'bg-surface-hover text-ink-secondary border-border',
  whatsapp: 'bg-[#25D366]/10 text-[#128C7E] border-[#25D366]/30',
  email: 'bg-[#4285F4]/10 text-[#4285F4] border-[#4285F4]/30',
  voice: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
};

const MODES: { id: LearningMode; label: string; description: string }[] = [
  { id: 'auto', label: 'Auto-improve', description: 'The AI updates its own prompts after every conversation. You can still edit or remove any lesson.' },
  { id: 'review', label: 'Review first', description: 'New lessons wait here for your approval before the AI uses them.' },
  { id: 'off', label: 'Off', description: 'No reviews, and no lessons are added to any prompt.' },
];

const MAX_LESSON_LENGTH = 240;

type PreviewChannel = 'whatsapp' | 'email' | 'voice';
const LESSONS_HEADING = 'LESSONS FROM PAST CONVERSATIONS';

/** Splits a prompt around its learned-lessons section so it can be highlighted. */
function splitAtLessons(prompt: string): [string, string, string] | null {
  const start = prompt.indexOf(LESSONS_HEADING);
  if (start === -1) return null;
  const blockStart = prompt.lastIndexOf('### AI LEARNING', start);
  const from = blockStart !== -1 && start - blockStart < 300 ? blockStart : start;
  const endMarker = prompt.indexOf('### END AI LEARNING', start);
  const blankLine = prompt.indexOf('\n\n', start);
  const to =
    endMarker !== -1 ? endMarker + '### END AI LEARNING'.length : blankLine !== -1 ? blankLine : prompt.length;
  return [prompt.slice(0, from), prompt.slice(from, to), prompt.slice(to)];
}

/** Self-improving prompts — see lib/aiLearning.ts. Lessons the AI learned from finished
 * conversations, which get added to every WhatsApp, email, outreach, and voice prompt. */
export const AiLearningView: React.FC<AiLearningViewProps> = ({ accessToken, campaignSettings, onUpdateSettings }) => {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeNote, setAnalyzeNote] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; channel: LessonChannel } | null>(null);
  const [newLesson, setNewLesson] = useState('');
  const [newChannel, setNewChannel] = useState<LessonChannel>('all');
  const [showHistory, setShowHistory] = useState(false);
  const [lastReviewedAt, setLastReviewedAt] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<PreviewChannel, string | null> | null>(null);
  const [previewChannel, setPreviewChannel] = useState<PreviewChannel>('whatsapp');
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewBoxRef = useRef<HTMLPreElement | null>(null);
  const highlightRef = useRef<HTMLSpanElement | null>(null);

  const mode: LearningMode = campaignSettings.aiLearningMode || 'auto';

  const call = async (method: 'GET' | 'POST', body?: Record<string, unknown>) => {
    const res = await fetch('/api/conversations?action=learning', {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status}).`);
    return data;
  };

  const load = async () => {
    if (!accessToken) {
      setConfigured(false);
      setLoading(false);
      return;
    }
    try {
      const data = await call('GET');
      setConfigured(!!data.configured);
      setLessons(Array.isArray(data.lessons) ? data.lessons : []);
      setLastReviewedAt(data.lastReviewedAt || null);
      if (data.error) setError(data.error);
    } catch (err: any) {
      setError(err?.message || 'Could not load lessons.');
    } finally {
      setLoading(false);
    }
  };

  const loadPreview = async () => {
    if (!accessToken) return;
    setPreviewLoading(true);
    try {
      const data = await call('POST', { op: 'preview' });
      setPreview(data.preview || null);
    } catch {
      // The preview is informational — the rest of the page works without it.
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // Lessons changed — the prompts changed with them.
  const activeSignature = lessons
    .filter((l) => l.status === 'active')
    .map((l) => `${l.id}:${l.channel}:${l.lesson}`)
    .join('|');
  useEffect(() => {
    if (!loading) loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSignature, campaignSettings.aiLearningMode, loading]);

  // Scroll the (long) prompt to the lessons section.
  useEffect(() => {
    const box = previewBoxRef.current;
    const mark = highlightRef.current;
    if (box && mark) box.scrollTop = Math.max(0, mark.offsetTop - box.offsetTop - 60);
  }, [preview, previewChannel]);

  const upsertLocal = (lesson: Lesson) =>
    setLessons((prev) => (prev.some((l) => l.id === lesson.id) ? prev.map((l) => (l.id === lesson.id ? lesson : l)) : [lesson, ...prev]));

  const mutate = async (id: string, body: Record<string, unknown>) => {
    setPendingId(id);
    setError(null);
    try {
      const data = await call('POST', body);
      if (data.lesson) upsertLocal(data.lesson);
      // Approving can archive overflow lessons server-side — reload to reflect that.
      if (body.op === 'set-status' && body.status === 'active') await load();
      return true;
    } catch (err: any) {
      setError(err?.message || 'Could not update the lesson.');
      return false;
    } finally {
      setPendingId(null);
    }
  };

  const analyze = async () => {
    setAnalyzing(true);
    setAnalyzeNote(null);
    setError(null);
    try {
      const { result } = await call('POST', { op: 'analyze' });
      if (result?.skipped) setAnalyzeNote(result.skipped);
      else if (!result?.reviewed) setAnalyzeNote('No newly finished conversations to learn from yet.');
      else {
        const parts = [
          `Reviewed ${result.reviewed} conversation${result.reviewed === 1 ? '' : 's'}`,
          result.added ? `${result.added} new lesson${result.added === 1 ? '' : 's'}` : 'no new lessons',
          result.reinforced ? `${result.reinforced} confirmed again` : null,
          result.retired ? `${result.retired} flagged for removal` : null,
        ].filter(Boolean);
        setAnalyzeNote(`${parts.join(' · ')}.`);
      }
      await load();
    } catch (err: any) {
      setError(err?.message || 'The review failed.');
    } finally {
      setAnalyzing(false);
    }
  };

  const changeMode = (next: LearningMode) => {
    onUpdateSettings({ ...campaignSettings, aiLearningMode: next });
    // The settings save is async — give it a moment, then re-sync the Vapi prompt's lessons block.
    setTimeout(() => call('POST', { op: 'sync' }).catch(() => {}), 2500);
  };

  const addLesson = async () => {
    const text = newLesson.trim();
    if (!text) return;
    if (await mutate('new', { op: 'add', lesson: text, channel: newChannel })) {
      setNewLesson('');
      setNewChannel('all');
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (await mutate(editing.id, { op: 'edit', id: editing.id, lesson: editing.text, channel: editing.channel })) setEditing(null);
  };

  const suggested = lessons.filter((l) => l.status === 'suggested');
  const active = lessons.filter((l) => l.status === 'active').sort((a, b) => b.evidence_count - a.evidence_count);
  const history = lessons.filter((l) => l.status === 'rejected' || l.status === 'archived');

  const card = 'bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card';
  const btn = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50';
  const selectClass = 'px-2.5 py-2 rounded-lg text-xs bg-surface border border-border text-ink';

  // A render function, not a nested component — a nested component remounts on every
  // parent render, which would drop textarea focus on each keystroke while editing.
  const renderLesson = (lesson: Lesson) => {
    const busy = pendingId === lesson.id;
    const isEditing = editing?.id === lesson.id;
    return (
      <div key={lesson.id} className="p-4 rounded-xl border border-border bg-canvas/60 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${CHANNEL_STYLES[lesson.channel]}`}>
            {CHANNEL_LABELS[lesson.channel]}
          </span>
          <span className="text-[10px] text-ink-muted">
            {lesson.source === 'manual'
              ? 'Added by you'
              : `Seen in ${lesson.evidence_count} conversation${lesson.evidence_count === 1 ? '' : 's'}`}
          </span>
        </div>

        {isEditing ? (
          <div className="space-y-2">
            <textarea
              value={editing.text}
              maxLength={MAX_LESSON_LENGTH}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 rounded-lg text-sm bg-surface border border-border text-ink focus:outline-none focus:border-[#128C7E]"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={editing.channel}
                onChange={(e) => setEditing({ ...editing, channel: e.target.value as LessonChannel })}
                className={selectClass}
              >
                {(Object.keys(CHANNEL_LABELS) as LessonChannel[]).map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABELS[c]}
                  </option>
                ))}
              </select>
              <button onClick={saveEdit} disabled={busy} className={`${btn} bg-brand-strong text-white border-transparent`}>
                <Check className="w-3 h-3" /> Save
              </button>
              <button onClick={() => setEditing(null)} className={`${btn} border-border text-ink-secondary hover:bg-surface-hover`}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink leading-relaxed">{lesson.lesson}</p>
        )}

        {lesson.rationale && !isEditing && <p className="text-xs text-ink-muted leading-relaxed">Why: {lesson.rationale}</p>}

        {lesson.status === 'active' && lesson.retire_reason && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-300 leading-relaxed flex-1">AI suggests removing this: {lesson.retire_reason}</p>
          </div>
        )}

        {!isEditing && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            {lesson.status === 'suggested' && (
              <>
                <button
                  onClick={() => mutate(lesson.id, { op: 'set-status', id: lesson.id, status: 'active' })}
                  disabled={busy}
                  className={`${btn} bg-brand-strong text-white border-transparent hover:bg-[#0d6e62]`}
                >
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Approve
                </button>
                <button
                  onClick={() => mutate(lesson.id, { op: 'set-status', id: lesson.id, status: 'rejected' })}
                  disabled={busy}
                  className={`${btn} border-border text-ink-secondary hover:bg-surface-hover`}
                >
                  <X className="w-3 h-3" /> Reject
                </button>
              </>
            )}
            {lesson.status === 'active' && lesson.retire_reason && (
              <button
                onClick={() => mutate(lesson.id, { op: 'keep', id: lesson.id })}
                disabled={busy}
                className={`${btn} border-border text-ink-secondary hover:bg-surface-hover`}
              >
                <Check className="w-3 h-3" /> Keep it
              </button>
            )}
            {lesson.status === 'active' && (
              <button
                onClick={() => mutate(lesson.id, { op: 'set-status', id: lesson.id, status: 'archived' })}
                disabled={busy}
                className={`${btn} border-border text-ink-secondary hover:bg-surface-hover`}
              >
                <Archive className="w-3 h-3" /> Remove
              </button>
            )}
            {(lesson.status === 'archived' || lesson.status === 'rejected') && (
              <button
                onClick={() => mutate(lesson.id, { op: 'set-status', id: lesson.id, status: 'active' })}
                disabled={busy}
                className={`${btn} border-border text-ink-secondary hover:bg-surface-hover`}
              >
                <RotateCcw className="w-3 h-3" /> Restore
              </button>
            )}
            {(lesson.status === 'suggested' || lesson.status === 'active') && (
              <button
                onClick={() => setEditing({ id: lesson.id, text: lesson.lesson, channel: lesson.channel })}
                className={`${btn} border-border text-ink-secondary hover:bg-surface-hover`}
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className={`${card} p-10 text-center text-sm text-ink-muted`}>
        <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-[#128C7E]" />
        Loading AI lessons…
      </div>
    );
  }

  if (!configured) {
    return (
      <div className={card}>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h3 className="font-semibold text-sm text-ink">{accessToken ? 'AI Learning isn’t set up yet' : 'Sign in to use AI Learning'}</h3>
            <p className="text-xs text-ink-secondary mt-1.5 leading-relaxed max-w-xl">
              {error || 'AI Learning needs the cloud database. Ask your workspace admin to finish setup.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Learning"
        description={
          <>
            After each finished conversation the AI reviews what worked and updates these lessons — the next message or
            call uses them. It runs on its own.
            <span className="flex items-center gap-1.5 mt-1.5 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full ${mode === 'off' ? 'bg-ink-muted' : 'bg-[#25D366] animate-pulse'}`} />
              {mode === 'off'
                ? 'Learning is off'
                : `Learning automatically${lastReviewedAt ? ` · last review ${new Date(lastReviewedAt).toLocaleString()}` : ' · waiting for the first finished conversation'}`}
            </span>
          </>
        }
        actions={
          <button
            onClick={analyze}
            disabled={analyzing || mode === 'off'}
            title="Reviews happen automatically. Use this only to process finished conversations right now."
            className={headerSecondaryButton}
          >
            {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {analyzing ? 'Reviewing…' : 'Review now'}
          </button>
        }
      />

      {(analyzeNote || error) && (
        <div
          className={`px-4 py-3 rounded-xl text-xs border ${
            error ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' : 'bg-[#128C7E]/10 text-emerald-300 border-[#128C7E]/30'
          }`}
        >
          {error || analyzeNote}
        </div>
      )}

      <div className={card}>
        <h3 className="text-sm font-semibold text-ink mb-3">How new lessons are applied</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => changeMode(m.id)}
              className={`text-left p-3 rounded-xl border transition-colors ${
                mode === m.id ? 'border-[#128C7E] bg-[#128C7E]/10' : 'border-border hover:bg-surface-hover'
              }`}
            >
              <div className="text-xs font-semibold text-ink">{m.label}</div>
              <div className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">{m.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className={card}>
        <h3 className="text-sm font-semibold text-ink mb-3">Where active lessons are applied</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] leading-relaxed">
          <div className="p-3 rounded-xl border border-border">
            <div className="text-xs font-semibold text-ink mb-0.5">WhatsApp &amp; Email replies</div>
            <div className="text-ink-muted">Added to the reply prompt on every incoming message, so the next reply already uses them.</div>
          </div>
          <div className="p-3 rounded-xl border border-border">
            <div className="text-xs font-semibold text-ink mb-0.5">Outreach copy</div>
            <div className="text-ink-muted">Added alongside your AI Tone &amp; Focus Instructions when first messages are generated.</div>
          </div>
          <div className="p-3 rounded-xl border border-border">
            <div className="text-xs font-semibold text-ink mb-0.5">Voice agent (Vapi)</div>
            <div className="text-ink-muted">
              Written into your Vapi prompt as an “AI LEARNING” section (visible in Channel Setup → Voice) and sent on every call.
            </div>
          </div>
        </div>
      </div>

      <div className={card}>
        <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
          <h3 className="text-sm font-semibold text-ink">Live prompts</h3>
          <div className="flex items-center gap-1">
            {(['whatsapp', 'email', 'voice'] as PreviewChannel[]).map((c) => (
              <button
                key={c}
                onClick={() => setPreviewChannel(c)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
                  previewChannel === c ? 'border-[#128C7E] bg-[#128C7E]/10 text-ink' : 'border-border text-ink-muted hover:bg-surface-hover'
                }`}
              >
                {c === 'whatsapp' ? 'WhatsApp reply' : c === 'email' ? 'Email reply' : 'Voice (Vapi)'}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-ink-muted mb-3">
          {previewChannel === 'voice'
            ? 'Your saved Vapi prompt as it is now. The highlighted section is kept up to date automatically; the rest is your own text from Channel Setup.'
            : 'The exact prompt the AI receives, shown for a sample incoming message (“Hi, what is this about?”). The highlighted section is what AI Learning adds.'}
        </p>
        {(() => {
          if (previewLoading && !preview) {
            return (
              <div className="py-8 text-center text-xs text-ink-muted">
                <Loader2 className="w-4 h-4 animate-spin mx-auto mb-2" /> Building the live prompts…
              </div>
            );
          }
          const text = preview?.[previewChannel];
          if (!text) {
            return (
              <p className="text-xs text-ink-muted py-4 text-center">
                {previewChannel === 'voice'
                  ? 'No saved Vapi prompt for this workspace yet. Save one in Channel Setup → Voice; lessons are still sent on every call.'
                  : 'Preview unavailable right now.'}
              </p>
            );
          }
          const parts = splitAtLessons(text);
          return (
            <>
              {!parts && (
                <p className="text-[11px] text-amber-300 mb-2">
                  {mode === 'off'
                    ? 'Learning is off, so no lessons are added to this prompt.'
                    : 'No active lessons apply to this channel yet.'}
                </p>
              )}
              <pre
                ref={previewBoxRef}
                className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed font-mono p-3 rounded-xl bg-canvas border border-border text-ink-muted"
              >
                {parts ? (
                  <>
                    {parts[0]}
                    <span ref={highlightRef} className="block my-1 p-2 rounded-lg bg-[#128C7E]/15 border border-[#128C7E]/40 text-emerald-300">
                      {parts[1]}
                    </span>
                    {parts[2]}
                  </>
                ) : (
                  text
                )}
              </pre>
            </>
          );
        })()}
      </div>

      {suggested.length > 0 && (
        <div className={card}>
          <h3 className="text-sm font-semibold text-ink mb-1">Waiting for your approval ({suggested.length})</h3>
          <p className="text-xs text-ink-muted mb-3">The AI doesn’t use these until you approve them.</p>
          <div className="space-y-3">
            {suggested.map(renderLesson)}
          </div>
        </div>
      )}

      <div className={card}>
        <h3 className="text-sm font-semibold text-ink mb-1">Active lessons ({active.length})</h3>
        <p className="text-xs text-ink-muted mb-3">
          {mode === 'off'
            ? 'Learning is off, so these aren’t being used right now.'
            : 'The AI follows these in every conversation on the matching channel. Up to 15 stay active; the weakest are archived first.'}
        </p>
        {active.length === 0 ? (
          <p className="text-xs text-ink-muted py-4 text-center">
            No active lessons yet. They appear as conversations finish, or add your own below.
          </p>
        ) : (
          <div className="space-y-3">
            {active.map(renderLesson)}
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-border space-y-2">
          <label className="text-xs font-medium text-ink-secondary">Add your own lesson</label>
          <textarea
            value={newLesson}
            maxLength={MAX_LESSON_LENGTH}
            onChange={(e) => setNewLesson(e.target.value)}
            rows={2}
            placeholder="e.g. When a prospect asks about pricing, say a team member will share a tailored quote on the call."
            className="w-full px-3 py-2 rounded-lg text-sm bg-surface border border-border text-ink placeholder:text-ink-muted focus:outline-none focus:border-[#128C7E]"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <select value={newChannel} onChange={(e) => setNewChannel(e.target.value as LessonChannel)} className={selectClass}>
              {(Object.keys(CHANNEL_LABELS) as LessonChannel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
            <button
              onClick={addLesson}
              disabled={!newLesson.trim() || pendingId === 'new'}
              className={`${btn} bg-brand-strong text-white border-transparent hover:bg-[#0d6e62]`}
            >
              {pendingId === 'new' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Add lesson
            </button>
          </div>
        </div>
      </div>

      {history.length > 0 && (
        <div className={card}>
          <button onClick={() => setShowHistory(!showHistory)} className="w-full flex items-center justify-between text-left">
            <span className="text-sm font-semibold text-ink">Removed and rejected ({history.length})</span>
            {showHistory ? <ChevronUp className="w-4 h-4 text-ink-muted" /> : <ChevronDown className="w-4 h-4 text-ink-muted" />}
          </button>
          {showHistory && (
            <div className="space-y-3 mt-3">
              {history.map(renderLesson)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
