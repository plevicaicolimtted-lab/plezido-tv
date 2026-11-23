import { FileText, PenLine, Radio, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type {
  ChannelCategory,
  DraftBroadcastScript,
  HostId,
  PermanentHost,
  ScriptFormat,
} from '../../shared/broadcastTypes';

interface ScriptWriterStudioProps {
  hosts: PermanentHost[];
  geminiConfigured: boolean;
  freeTierMode: boolean;
  onWriteScript: (params: {
    channel: ChannelCategory;
    primaryHostId: HostId;
    coHostId?: HostId;
    format: ScriptFormat;
    topic: string;
  }) => Promise<DraftBroadcastScript>;
  onAirScript: (draft: DraftBroadcastScript, requestedBy?: string) => Promise<void>;
}

const STARTER_TOPICS: Array<{ label: string; channel: ChannelCategory; format: ScriptFormat; topic: string }> = [
  {
    label: 'Global Clean Tech Update',
    channel: 'news',
    format: 'breaking-news',
    topic: 'Latest breakthroughs in grid-scale clean energy storage and solar microgrids',
  },
  {
    label: 'Midnight Synth Session',
    channel: 'music',
    format: 'music-intro',
    topic: 'Analog tape synthesis and warm Rhodes grooves at 86 BPM',
  },
  {
    label: 'Future of AI Media',
    channel: 'culture',
    format: 'live-debate',
    topic: 'How permanent AI hosts and real-time fact-checking reshape live broadcasting',
  },
];

export function ScriptWriterStudio({
  hosts,
  geminiConfigured,
  freeTierMode,
  onWriteScript,
  onAirScript,
}: ScriptWriterStudioProps) {
  const [channel, setChannel] = useState<ChannelCategory>('news');
  const [format, setFormat] = useState<ScriptFormat>('breaking-news');
  const [coHostEnabled, setCoHostEnabled] = useState(false);
  const [topic, setTopic] = useState('');
  const [draft, setDraft] = useState<DraftBroadcastScript | null>(null);
  const [writing, setWriting] = useState(false);
  const [airing, setAiring] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const primaryHostId: HostId =
    channel === 'news' ? 'elena' : channel === 'music' ? 'marcus' : 'sora';
  const defaultCoHostId: HostId =
    primaryHostId === 'elena' ? 'sora' : primaryHostId === 'marcus' ? 'sora' : 'elena';

  const primaryHost = hosts.find((h) => h.id === primaryHostId) ?? hosts[0];

  const handleGenerateDraft = async () => {
    setWriting(true);
    setStatusMessage(null);
    try {
      const generated = await onWriteScript({
        channel,
        primaryHostId,
        coHostId: coHostEnabled ? defaultCoHostId : undefined,
        format,
        topic,
      });
      setDraft(generated);
      setStatusMessage({
        ok: true,
        text: 'Gemini drafted your broadcast script. Review or edit lines below, then click Broadcast Now.',
      });
    } catch (err) {
      setStatusMessage({
        ok: false,
        text: err instanceof Error ? err.message : 'Unable to write script with Gemini.',
      });
    } finally {
      setWriting(false);
    }
  };

  const handleBroadcastNow = async (overrideDraft?: DraftBroadcastScript) => {
    const targetDraft = overrideDraft ?? draft;
    if (!targetDraft) return;
    setAiring(true);
    setStatusMessage(null);
    try {
      await onAirScript(targetDraft, 'Producer Script Studio');
      setStatusMessage({
        ok: true,
        text: 'On air now — Gemini free-tier fact-check passed, voice synthesized, and live studio stage updated.',
      });
      document.getElementById('live-stage')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setStatusMessage({
        ok: false,
        text: err instanceof Error ? err.message : 'Unable to start broadcast.',
      });
    } finally {
      setAiring(false);
    }
  };

  const handleQuickWriteAndBroadcast = async () => {
    setWriting(true);
    setStatusMessage(null);
    try {
      const generated = await onWriteScript({
        channel,
        primaryHostId,
        coHostId: coHostEnabled ? defaultCoHostId : undefined,
        format,
        topic,
      });
      setDraft(generated);
      setWriting(false);
      await handleBroadcastNow(generated);
    } catch (err) {
      setWriting(false);
      setStatusMessage({
        ok: false,
        text: err instanceof Error ? err.message : 'Unable to write and broadcast script.',
      });
    }
  };

  const updateBeatText = (index: number, nextText: string) => {
    if (!draft) return;
    const updatedBeats = draft.dialogueBeats.map((b, i) =>
      i === index ? { ...b, text: nextText } : b
    );
    setDraft({ ...draft, dialogueBeats: updatedBeats });
  };

  return (
    <section
      id="script-studio"
      className="mx-auto max-w-[1440px] px-4 sm:px-6 py-10 border-t border-white/[0.08]"
    >
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-7">
        <div>
          <p className="text-xs font-medium text-slate-400">
            Gemini Free-Tier Scriptwriting, Fact-Checking &amp; Voice Broadcast
          </p>
          <h2 className="mt-1 font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
            AI Script Writer &amp; Instant Broadcast Studio
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <PenLine className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
            <span>
              Scripts: {geminiConfigured ? 'Gemini Free-Tier Active' : 'Gemini Ready (Fallback Active)'}
            </span>
          </span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5">
            <Radio className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            <span>
              Broadcast: {freeTierMode ? 'Gemini Voice + Studio Stage (0 UGX Free Tier)' : 'Studio Active'}
            </span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Gemini Script Brief Controls */}
        <div className="lg:col-span-5 rounded-xl border border-white/[0.08] bg-[#0B0F17] p-6 space-y-5">
          <div>
            <h3 className="font-display text-lg font-semibold text-white">
              1. Compose Broadcast Brief
            </h3>
            <p className="mt-1 text-sm text-slate-400">
              Direct free-tier Gemini to research and write a structured teleprompter script for your
              chosen host, then broadcast it live with voice &amp; studio music.
            </p>
          </div>

          {/* Channel / Host */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Studio Channel &amp; Permanent Host
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
                  onClick={() => {
                    setChannel(opt.id);
                    if (opt.id === 'news') setFormat('breaking-news');
                    else if (opt.id === 'music') setFormat('music-intro');
                    else setFormat('editorial-essay');
                  }}
                  className={`rounded-md py-2 px-2 text-xs font-medium transition-colors whitespace-nowrap ${
                    channel === opt.id
                      ? 'bg-[#E11D48] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Format + Co-Host */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="script-format" className="block text-xs font-medium text-slate-300 mb-1.5">
                Script Format
              </label>
              <select
                id="script-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as ScriptFormat)}
                className="w-full rounded-lg border border-white/10 bg-[#070A10] px-3 py-2 text-xs text-white focus:border-[#E11D48] focus:outline-none"
              >
                <option value="breaking-news">Breaking News Dispatch</option>
                <option value="music-intro">Music Set &amp; Trend Intro</option>
                <option value="editorial-essay">Cultural &amp; Tech Essay</option>
                <option value="live-debate">Dual-Host Debate</option>
              </select>
            </div>

            <div className="flex flex-col justify-end">
              <button
                type="button"
                onClick={() => setCoHostEnabled((v) => !v)}
                className={`w-full rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  coHostEnabled
                    ? 'border-[#E11D48] bg-[#E11D48]/15 text-white'
                    : 'border-white/10 bg-[#070A10] text-slate-300 hover:text-white'
                }`}
              >
                {coHostEnabled ? 'Co-Host Dialogue: Enabled' : 'Single Anchor Script'}
              </button>
            </div>
          </div>

          {/* Topic Input */}
          <div>
            <label htmlFor="gemini-script-topic" className="block text-xs font-medium text-slate-300 mb-1.5">
              Topic, Story Angle, or Musical Prompt
            </label>
            <textarea
              id="gemini-script-topic"
              rows={3}
              maxLength={240}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={`Describe what ${primaryHost.name} should write and broadcast…`}
              className="w-full rounded-lg border border-white/10 bg-[#070A10] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {STARTER_TOPICS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setChannel(preset.channel);
                    setFormat(preset.format);
                    setCoHostEnabled(preset.format === 'live-debate');
                    setTopic(preset.topic);
                  }}
                  className="text-[11px] text-slate-400 hover:text-white underline decoration-white/20 underline-offset-4"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <button
              type="button"
              disabled={writing || airing}
              onClick={() => void handleGenerateDraft()}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 bg-[#161C29] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E2638] disabled:opacity-50 transition-colors"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{writing ? 'Writing Draft…' : 'Write Script Draft'}</span>
            </button>

            <button
              type="button"
              disabled={writing || airing}
              onClick={() => void handleQuickWriteAndBroadcast()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors"
            >
              <Radio className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{writing || airing ? 'Preparing Air…' : 'Write & Broadcast Now'}</span>
            </button>
          </div>

          {statusMessage && (
            <p
              className={`rounded-lg border p-3 text-xs leading-relaxed ${
                statusMessage.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
              }`}
            >
              {statusMessage.text}
            </p>
          )}
        </div>

        {/* Right: Editable Teleprompter Script & Broadcast Now Trigger */}
        <div className="lg:col-span-7 rounded-xl border border-white/[0.08] bg-[#0B0F17] overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] bg-[#0F131C] px-5 py-3.5">
            <div className="flex items-center gap-2 text-xs font-medium text-white">
              <FileText className="h-4 w-4 text-slate-300" aria-hidden="true" />
              <span>2. Live Teleprompter Script &amp; Broadcast Control</span>
            </div>

            {draft && (
              <button
                type="button"
                disabled={airing || writing}
                onClick={() => void handleBroadcastNow()}
                className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors"
              >
                <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{airing ? 'Going Live…' : 'Broadcast Now'}</span>
              </button>
            )}
          </div>

          {!draft ? (
            <div className="p-8 sm:p-12 text-center space-y-3">
              <p className="font-display text-lg font-semibold text-white">
                No Script Draft Loaded Yet
              </p>
              <p className="mx-auto max-w-md text-sm text-slate-400">
                Enter a topic on the left and click <strong className="text-slate-200">Write Script Draft</strong> to
                preview and edit Gemini’s teleprompter lines, or click{' '}
                <strong className="text-slate-200">Write &amp; Broadcast Now</strong> to go live immediately.
              </p>
            </div>
          ) : (
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="draft-headline" className="block text-xs font-medium text-slate-400 mb-1">
                    Broadcast Headline
                  </label>
                  <input
                    id="draft-headline"
                    type="text"
                    value={draft.headline}
                    onChange={(e) => setDraft({ ...draft, headline: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-[#070A10] px-3 py-2 text-sm font-medium text-white focus:border-[#E11D48] focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="draft-subheadline" className="block text-xs font-medium text-slate-400 mb-1">
                    Lower-Third Subheadline
                  </label>
                  <input
                    id="draft-subheadline"
                    type="text"
                    value={draft.subheadline}
                    onChange={(e) => setDraft({ ...draft, subheadline: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-[#070A10] px-3 py-2 text-sm text-slate-200 focus:border-[#E11D48] focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-xs font-medium text-slate-400">
                  Teleprompter Dialogue Beats (Editable Before Air)
                </p>
                {draft.dialogueBeats.map((beat, idx) => {
                  const speaker = hosts.find((h) => h.id === beat.speakerId) ?? primaryHost;
                  return (
                    <div
                      key={idx}
                      className="rounded-lg border border-white/[0.08] bg-[#070A10] p-3.5 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                        <span className="font-semibold text-white">{speaker.name}</span>
                        <span className="font-mono-tabular">
                          Beat 0{idx + 1} · Camera: {beat.cameraAngle.replace('-', ' ')}
                        </span>
                      </div>
                      <textarea
                        rows={2}
                        value={beat.text}
                        onChange={(e) => updateBeatText(idx, e.target.value)}
                        className="w-full rounded border border-white/10 bg-[#0B0F17] px-3 py-2 text-sm leading-relaxed text-slate-100 focus:border-[#E11D48] focus:outline-none"
                      />
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4 text-xs text-slate-400">
                <span>
                  Score: {draft.musicScore.title} · {draft.musicScore.bpm} BPM ·{' '}
                  {draft.musicScore.musicalKey}
                </span>
                <span>
                  {draft.isLiveGrounded
                    ? `Grounded with ${draft.groundingSources.length} verified source(s)`
                    : 'Studio scripted segment'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
