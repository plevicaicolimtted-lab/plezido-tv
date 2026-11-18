import { AlertTriangle, CheckCircle2, Send, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type {
  ChannelCategory,
  ModerationReport,
  ViewerRequest,
} from '../../shared/broadcastTypes';

interface EditorialModerationPanelProps {
  queue: ViewerRequest[];
  moderationLog: ModerationReport[];
  onSubmitRequest: (
    topic: string,
    category: ChannelCategory,
    requesterName: string
  ) => Promise<{ accepted: boolean; message: string }>;
}

function formatShortTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`;
}

function statusDisplay(status: ViewerRequest['status']): { label: string; colorClass: string } {
  switch (status) {
    case 'on-air':
      return { label: 'On Air Now', colorClass: 'text-[#FB7185] font-semibold' };
    case 'producing':
      return { label: 'Producing & Fact-Checking', colorClass: 'text-amber-300 font-medium' };
    case 'queued':
      return { label: 'Cleared · Queued', colorClass: 'text-emerald-300' };
    case 'flagged':
      return { label: 'Blocked by Filter', colorClass: 'text-rose-400' };
    case 'aired':
      return { label: 'Aired', colorClass: 'text-slate-400' };
  }
}

function verdictDisplay(verdict: ModerationReport['verdict']): {
  label: string;
  colorClass: string;
} {
  switch (verdict) {
    case 'cleared':
      return { label: 'Cleared', colorClass: 'text-emerald-400' };
    case 'cleared-with-caution':
      return { label: 'Caution Framed', colorClass: 'text-amber-300' };
    case 'flagged-revised':
      return { label: 'Flagged & Revised Pre-Air', colorClass: 'text-amber-300' };
    case 'blocked':
      return { label: 'Blocked Pre-Queue', colorClass: 'text-rose-400' };
  }
}

export function EditorialModerationPanel({
  queue,
  moderationLog,
  onSubmitRequest,
}: EditorialModerationPanelProps) {
  const [topic, setTopic] = useState('');
  const [category, setCategory] = useState<ChannelCategory>('news');
  const [requesterName, setRequesterName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ accepted: boolean; text: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'moderation' | 'queue'>('moderation');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (topic.trim().length < 3) {
      setFeedback({
        accepted: false,
        text: 'Enter a topic or music mood of at least 3 characters.',
      });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await onSubmitRequest(topic, category, requesterName);
      setFeedback({ accepted: res.accepted, text: res.message });
      if (res.accepted) {
        setTopic('');
      }
    } catch (err) {
      setFeedback({
        accepted: false,
        text: err instanceof Error ? err.message : 'Unable to submit topic right now.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      id="editorial-desk"
      className="mx-auto max-w-[1440px] px-4 sm:px-6 py-10 border-t border-white/[0.08]"
    >
      <div className="mb-7">
        <p className="text-xs font-medium text-slate-400">
          Real-Time Broadcast Standards &amp; Audience Queue
        </p>
        <h2 className="mt-1 font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
          Editorial Fact-Check Desk &amp; Topic Requests
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Viewer Topic Submission Form (pre-screened in real time) */}
        <form
          onSubmit={handleSubmit}
          className="lg:col-span-5 rounded-xl border border-white/[0.08] bg-[#0B0F17] p-6 space-y-5"
        >
          <div>
            <h3 className="font-display text-lg font-semibold text-white">
              Submit a Live Broadcast Request
            </h3>
            <p className="mt-1 text-sm text-slate-400">
              Every submission passes PleziDo TV’s real-time safety and factual screening before
              entering the live host queue.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-2">
                Target Studio Channel
              </label>
              <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-[#070A10] p-1 border border-white/[0.06]">
                {(
                  [
                    { id: 'news', label: 'News · Elena' },
                    { id: 'music', label: 'Music · Marcus' },
                    { id: 'culture', label: 'Culture · Sora' },
                  ] as Array<{ id: ChannelCategory; label: string }>
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setCategory(opt.id)}
                    className={`rounded-md py-2 px-2 text-xs font-medium transition-colors whitespace-nowrap ${
                      category === opt.id
                        ? 'bg-[#E11D48] text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="viewer-name" className="block text-xs font-medium text-slate-300 mb-1.5">
                Your Name (Optional)
              </label>
              <input
                id="viewer-name"
                type="text"
                maxLength={40}
                value={requesterName}
                onChange={(e) => setRequesterName(e.target.value)}
                placeholder="e.g. Nadia from Kampala"
                className="w-full rounded-lg border border-white/10 bg-[#070A10] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="viewer-topic" className="block text-xs font-medium text-slate-300 mb-1.5">
                News Topic, Question, or Music Mood
              </label>
              <textarea
                id="viewer-topic"
                rows={3}
                maxLength={180}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={
                  category === 'news'
                    ? 'e.g. Latest advances in East African solar microgrids'
                    : category === 'music'
                      ? 'e.g. Rainy midnight ambient Rhodes at 78 BPM'
                      : 'e.g. How brutalist architecture influences modern sound design'
                }
                className="w-full rounded-lg border border-white/10 bg-[#070A10] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
              />
            </div>
          </div>

          {feedback && (
            <div
              className={`flex items-start gap-2.5 rounded-lg border p-3 text-xs leading-relaxed ${
                feedback.accepted
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
              }`}
            >
              {feedback.accepted ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" aria-hidden="true" />
              ) : (
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" aria-hidden="true" />
              )}
              <span>{feedback.text}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            <span>{submitting ? 'Screening & Submitting…' : 'Screen & Queue for Live Air'}</span>
          </button>
        </form>

        {/* Right: Real-Time Moderation Log & Live Request Queue */}
        <div className="lg:col-span-7 rounded-xl border border-white/[0.08] bg-[#0B0F17] overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] bg-[#0F131C] px-5 py-3.5">
            <div className="flex items-center gap-1 rounded-lg bg-[#070A10] p-1 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => setActiveTab('moderation')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === 'moderation'
                    ? 'bg-white text-[#06080D]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Pre-Broadcast Fact-Check Log ({moderationLog.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('queue')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === 'queue'
                    ? 'bg-white text-[#06080D]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Live Request Queue ({queue.length})
              </button>
            </div>

            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Real-Time Gate Active</span>
            </span>
          </div>

          {activeTab === 'moderation' ? (
            <div className="divide-y divide-white/[0.06] max-h-[420px] overflow-y-auto">
              {moderationLog.map((entry) => {
                const v = verdictDisplay(entry.verdict);
                return (
                  <div key={entry.id} className="p-4 sm:px-5 hover:bg-white/[0.02] transition-colors">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={`font-semibold ${v.colorClass}`}>{v.label}</span>
                        <span aria-hidden="true" className="text-slate-600">
                          ·
                        </span>
                        <span className="text-slate-400">
                          {entry.targetType === 'segment' ? 'Broadcast Segment' : 'Viewer Prompt'}
                        </span>
                        <span aria-hidden="true" className="text-slate-600">
                          ·
                        </span>
                        <span className="text-slate-400">
                          Fact-check: {entry.factCheckStatus.replace('-', ' ')}
                        </span>
                      </div>
                      <span className="font-mono-tabular text-slate-500">
                        {formatShortTime(entry.checkedAtMs)}
                      </span>
                    </div>

                    <p className="mt-1.5 text-sm font-medium text-white">
                      {entry.headlineOrTopic}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">{entry.notes}</p>

                    {entry.flags.length > 0 && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>Flags: {entry.flags.join(' · ')}</span>
                      </div>
                    )}
                  </div>
                );
              })}

              {moderationLog.length === 0 && (
                <div className="p-8 text-center text-sm text-slate-400">
                  Editorial verification checks appear here automatically before every segment airs.
                </div>
              )}
            </div>
          ) : (
            <div className="divide-y divide-white/[0.06] max-h-[420px] overflow-y-auto">
              {queue.map((req) => {
                const st = statusDisplay(req.status);
                return (
                  <div key={req.id} className="p-4 sm:px-5 hover:bg-white/[0.02] transition-colors">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={st.colorClass}>{st.label}</span>
                        <span aria-hidden="true" className="text-slate-600">
                          ·
                        </span>
                        <span className="text-slate-400 capitalize">{req.category}</span>
                        <span aria-hidden="true" className="text-slate-600">
                          ·
                        </span>
                        <span className="text-slate-400">By {req.requesterName}</span>
                      </div>
                      <span className="font-mono-tabular text-slate-500">
                        {formatShortTime(req.submittedAtMs)}
                      </span>
                    </div>

                    <p className="mt-1.5 text-sm font-medium text-white">{req.topic}</p>
                    {req.moderationReason && (
                      <p className="mt-1 text-xs text-rose-300">{req.moderationReason}</p>
                    )}
                  </div>
                );
              })}

              {queue.length === 0 && (
                <div className="p-8 text-center text-sm text-slate-400">
                  No viewer requests queued yet. Submit a topic on the left to put it on the live
                  broadcast schedule.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
