import { Send, Tv, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  BroadcastSegment,
  BroadcastSyncState,
  ChannelCategory,
  ChannelSelection,
  ModerationReport,
  ScheduleSlot,
  ViewerRequest,
} from '../../shared/broadcastTypes';
import { broadcastAudioEngine } from '../audio/broadcastAudioEngine';
import { OfflineIndicator } from '../components/OfflineIndicator';
import { ProgramGuide } from '../components/ProgramGuide';
import {
  apiUrl,
  getConfiguredFallbackApiBase,
  setResolvedApiBase,
} from '../lib/apiUrl';
import { ViewerStage } from './ViewerStage';

export default function ViewerApp() {
  const [broadcastState, setBroadcastState] = useState<BroadcastSyncState | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<ChannelSelection>('auto');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [streamConnected, setStreamConnected] = useState(false);
  const [statelessMode, setStatelessMode] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Viewer topic / song request state
  const [topic, setTopic] = useState('');
  const [category, setCategory] = useState<ChannelCategory>('news');
  const [requesterName, setRequesterName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [requestFeedback, setRequestFeedback] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let retryStateTimer: number | null = null;
    let attemptCount = 0;
    let hydrated = false;
    let disposed = false;

    const hydrateInitial = async () => {
      try {
        let res = await fetch(apiUrl('/api/broadcast/state'), { cache: 'no-store' });
        if (res.status === 404) {
          const fallbackBase = getConfiguredFallbackApiBase();
          if (fallbackBase) {
            const fallbackRes = await fetch(`${fallbackBase}/api/broadcast/state`, {
              cache: 'no-store',
            }).catch(() => null);
            if (fallbackRes && fallbackRes.ok) {
              setResolvedApiBase(fallbackBase);
              res = fallbackRes;
            }
          }
        }
        if (!res.ok) throw new Error('Unable to tune into PleziDo TV right now');
        const data = (await res.json()) as BroadcastSyncState;
        if (!disposed) {
          hydrated = true;
          setClockOffsetMs(data.serverTimeMs - Date.now());
          setBroadcastState((prev) => prev ?? data);
          setStreamConnected(true);
          setLoadError(null);
        }
      } catch (err) {
        if (disposed || hydrated) return;
        attemptCount += 1;
        if (attemptCount >= 3) {
          setLoadError(
            err instanceof Error ? err.message : 'Unable to tune into PleziDo TV right now'
          );
        }
        const delayMs = attemptCount === 1 ? 1200 : attemptCount === 2 ? 2000 : 4000;
        retryStateTimer = window.setTimeout(() => {
          retryStateTimer = null;
          void hydrateInitial();
        }, delayMs);
      }
    };

    const connectStream = () => {
      if (disposed) return;
      let isStatelessStream = false;
      eventSource = new EventSource(apiUrl('/api/broadcast/stream'));

      eventSource.onopen = () => {
        if (!disposed) {
          setStreamConnected(true);
          setLoadError(null);
        }
      };

      eventSource.onmessage = (evt) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(evt.data) as {
            type: string;
            mode?: 'stateless' | 'live';
            state?: BroadcastSyncState;
            segment?: BroadcastSegment;
            channel?: ChannelCategory;
            channelSegments?: Record<ChannelCategory, BroadcastSegment>;
            recentSegments?: BroadcastSegment[];
            queue?: ViewerRequest[];
            moderationLog?: ModerationReport[];
            schedule?: ScheduleSlot[];
            nextTransitionAtMs?: number;
            serverTimeMs?: number;
            viewerCount?: number;
          };

          if (msg.type === 'init' && msg.state) {
            if (msg.mode === 'stateless') {
              isStatelessStream = true;
              setStatelessMode(true);
            }
            hydrated = true;
            if (retryStateTimer !== null) {
              window.clearTimeout(retryStateTimer);
              retryStateTimer = null;
            }
            setClockOffsetMs(msg.state.serverTimeMs - Date.now());
            setBroadcastState((prev) => prev ?? msg.state!);
            setStreamConnected(true);
            setLoadError(null);
            return;
          }

          if (msg.type === 'clock:sync' && isStatelessStream) {
            if (typeof msg.serverTimeMs === 'number') {
              setClockOffsetMs(msg.serverTimeMs - Date.now());
            }
            eventSource?.close();
            eventSource = null;
            return;
          }

          setBroadcastState((prev) => {
            if (!prev) return prev;
            switch (msg.type) {
              case 'segment:live':
                return {
                  ...prev,
                  activeNetworkSegment: msg.segment ?? prev.activeNetworkSegment,
                  channelSegments: msg.channelSegments ?? prev.channelSegments,
                  recentSegments: msg.recentSegments ?? prev.recentSegments,
                  queue: msg.queue ?? prev.queue,
                  schedule: msg.schedule ?? prev.schedule,
                  nextTransitionAtMs: msg.nextTransitionAtMs ?? prev.nextTransitionAtMs,
                };
              case 'channel:updated':
                if (!msg.channel || !msg.segment) return prev;
                return {
                  ...prev,
                  channelSegments: {
                    ...prev.channelSegments,
                    [msg.channel]: msg.segment,
                  },
                };
              case 'queue:updated':
                return {
                  ...prev,
                  queue: msg.queue ?? prev.queue,
                };
              case 'viewers:count':
                return {
                  ...prev,
                  viewerCount: msg.viewerCount ?? prev.viewerCount,
                };
              case 'clock:sync':
                if (typeof msg.serverTimeMs === 'number') {
                  setClockOffsetMs(msg.serverTimeMs - Date.now());
                }
                return {
                  ...prev,
                  viewerCount: msg.viewerCount ?? prev.viewerCount,
                };
              default:
                return prev;
            }
          });
        } catch {
          // Ignore malformed keepalive chunks
        }
      };

      eventSource.onerror = () => {
        if (disposed || isStatelessStream) {
          eventSource?.close();
          eventSource = null;
          return;
        }
        setStreamConnected(false);
        eventSource?.close();
        eventSource = null;
        if (reconnectTimer === null) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connectStream();
          }, 3000);
        }
      };
    };

    void hydrateInitial().finally(() => {
      if (!disposed) {
        connectStream();
      }
    });

    return () => {
      disposed = true;
      eventSource?.close();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (retryStateTimer !== null) window.clearTimeout(retryStateTimer);
    };
  }, []);

  // Keep 24/7 broadcast rotating cleanly across UTC windows in stateless deployments
  useEffect(() => {
    if (!broadcastState) return;
    const activeEndsAtMs = broadcastState.activeNetworkSegment.endsAtMs;
    const activeSegId = broadcastState.activeNetworkSegment.id;
    const graceMs = statelessMode ? 600 : 2500;
    const waitMs = Math.max(800, activeEndsAtMs - (Date.now() + clockOffsetMs) + graceMs);

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      try {
        const res = await fetch(apiUrl('/api/broadcast/state'), { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const fresh = (await res.json()) as BroadcastSyncState;
        if (cancelled) return;

        setClockOffsetMs(fresh.serverTimeMs - Date.now());
        setStreamConnected(true);
        setBroadcastState((prev) => {
          if (!prev) return fresh;
          if (prev.activeNetworkSegment.id !== activeSegId) return prev;
          return {
            ...fresh,
            queue: prev.queue.length > 0 ? prev.queue : fresh.queue,
          };
        });
      } catch {
        // Keep active segment if poll fails transiently
      }
    }, waitMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    broadcastState?.activeNetworkSegment.id,
    broadcastState?.activeNetworkSegment.endsAtMs,
    clockOffsetMs,
    statelessMode,
  ]);

  const displayedSegment: BroadcastSegment | null = useMemo(() => {
    if (!broadcastState) return null;
    if (selectedChannel === 'auto') {
      return broadcastState.activeNetworkSegment;
    }
    return broadcastState.channelSegments[selectedChannel] ?? broadcastState.activeNetworkSegment;
  }, [broadcastState, selectedChannel]);

  useEffect(() => {
    if (!displayedSegment) return;
    const elapsedSec = Math.max(
      0,
      (Date.now() + clockOffsetMs - displayedSegment.startedAtMs) / 1000
    );
    void broadcastAudioEngine.syncSegment(displayedSegment, elapsedSec);
  }, [displayedSegment, audioEnabled, clockOffsetMs]);

  const handleEnableAudio = useCallback(async () => {
    await broadcastAudioEngine.enable();
    broadcastAudioEngine.setVolume(volume);
    setAudioEnabled(true);
    if (displayedSegment) {
      const elapsedSec = Math.max(
        0,
        (Date.now() + clockOffsetMs - displayedSegment.startedAtMs) / 1000
      );
      await broadcastAudioEngine.syncSegment(displayedSegment, elapsedSec);
    }
  }, [displayedSegment, clockOffsetMs, volume]);

  const handleToggleAudio = useCallback(() => {
    if (audioEnabled) {
      broadcastAudioEngine.disable();
      setAudioEnabled(false);
    } else {
      void handleEnableAudio();
    }
  }, [audioEnabled, handleEnableAudio]);

  const handleVolumeChange = useCallback((next: number) => {
    setVolume(next);
    broadcastAudioEngine.setVolume(next);
  }, []);

  const handleTuneChannel = useCallback((channel: ChannelSelection) => {
    setSelectedChannel(channel);
    document.getElementById('watch-live')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleViewerRequest = async (e: FormEvent) => {
    e.preventDefault();
    if (topic.trim().length < 3) {
      setRequestFeedback({
        ok: false,
        text: 'Please enter a topic or music vibe of at least 3 characters.',
      });
      return;
    }

    setSubmitting(true);
    setRequestFeedback(null);
    try {
      const res = await fetch(apiUrl('/api/broadcast/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          category,
          requesterName: requesterName.trim() || 'Viewer',
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        accepted?: boolean;
        report?: ModerationReport;
        error?: string;
      };

      if (res.status === 422 && data.report) {
        setRequestFeedback({
          ok: false,
          text: `Topic not accepted: ${data.report.notes}`,
        });
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || 'Unable to submit request right now.');
      }

      setTopic('');
      setRequestFeedback({
        ok: true,
        text: 'Topic submitted to the PleziDo TV broadcast queue.',
      });
    } catch (err) {
      setRequestFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Unable to submit request.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#06080D] text-[#F4F6FA]">
      {/* Viewer Top Bar (3-zone contract) */}
      <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-[#06080D]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-3.5">
          <a
            href="#watch-live"
            className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            PleziDo TV
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
            <a
              href="#watch-live"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Watch Live
            </a>
            <a
              href="#channels"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Channels
            </a>
            <a
              href="#program-guide"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              TV Guide
            </a>
            <a
              href="#viewer-request"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Request Topic
            </a>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleToggleAudio}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                audioEnabled
                  ? 'bg-[#182030] text-white border border-white/15 hover:bg-[#212B3F]'
                  : 'bg-[#E11D48] text-white hover:bg-[#BE123C]'
              }`}
            >
              {audioEnabled ? (
                <>
                  <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Mute TV</span>
                </>
              ) : (
                <>
                  <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Watch With Sound</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <main>
        {loadError && !broadcastState && (
          <div className="mx-auto max-w-[1440px] px-4 sm:px-6 pt-8">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-5 text-sm text-rose-200">
              <span>{loadError} · Retrying automatically…</span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg border border-rose-400/40 bg-rose-500/20 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-500/30 transition-colors"
              >
                Reconnect Now
              </button>
            </div>
          </div>
        )}

        {!broadcastState || !displayedSegment ? (
          <section className="mx-auto max-w-[1440px] px-4 sm:px-6 py-8">
            <div className="aspect-video w-full rounded-xl border border-white/[0.08] bg-[#0B0F17] animate-pulse flex items-center justify-center">
              <span className="text-sm text-slate-400">Tuning into PleziDo TV live broadcast…</span>
            </div>
          </section>
        ) : (
          <>
            <ViewerStage
              segment={displayedSegment}
              hosts={broadcastState.hosts}
              selectedChannel={selectedChannel}
              onSelectChannel={setSelectedChannel}
              audioEnabled={audioEnabled}
              onEnableAudio={() => void handleEnableAudio()}
              volume={volume}
              onVolumeChange={handleVolumeChange}
              clockOffsetMs={clockOffsetMs}
              viewerCount={broadcastState.viewerCount}
              streamConnected={streamConnected}
            />

            {/* Channels Now Airing Strip */}
            <section
              id="channels"
              className="mx-auto max-w-[1440px] px-4 sm:px-6 py-10 border-t border-white/[0.08]"
            >
              <div className="mb-6">
                <p className="text-xs font-medium text-slate-400">Live Network Lineup</p>
                <h2 className="mt-1 font-display text-2xl font-bold tracking-tight text-white">
                  Switch Channels
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {(['news', 'music', 'culture'] as ChannelCategory[]).map((ch) => {
                  const seg = broadcastState.channelSegments[ch];
                  const host = broadcastState.hosts.find((h) => h.id === seg.primaryHostId);
                  const isCurrent =
                    selectedChannel === ch ||
                    (selectedChannel === 'auto' &&
                      broadcastState.activeNetworkSegment.channel === ch);

                  return (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => handleTuneChannel(ch)}
                      className={`text-left rounded-xl border p-5 transition-colors ${
                        isCurrent
                          ? 'border-[#E11D48]/60 bg-[#0F1522]'
                          : 'border-white/[0.08] bg-[#0B0F17] hover:bg-[#101624]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                        <span className="font-semibold text-white">{seg.showTitle}</span>
                        <span className="font-mono-tabular">
                          {isCurrent ? 'Watching' : 'Tune In'}
                        </span>
                      </div>
                      <h3 className="mt-2 font-display text-base font-semibold text-white line-clamp-2">
                        {seg.headline}
                      </h3>
                      <p className="mt-1.5 text-xs text-slate-400 line-clamp-2">
                        {host?.name} · {seg.subheadline}
                      </p>
                    </button>
                  );
                })}
              </div>
            </section>

            <ProgramGuide
              schedule={broadcastState.schedule}
              hosts={broadcastState.hosts}
              onTuneChannel={handleTuneChannel}
            />

            {/* Viewer Topic / Song Request */}
            <section
              id="viewer-request"
              className="mx-auto max-w-[1440px] px-4 sm:px-6 py-10 border-t border-white/[0.08]"
            >
              <div className="max-w-2xl rounded-xl border border-white/[0.08] bg-[#0B0F17] p-6 sm:p-8">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
                  <Tv className="h-4 w-4 text-[#E11D48]" aria-hidden="true" />
                  <span>Audience Requests</span>
                </div>
                <h2 className="mt-1 font-display text-2xl font-bold tracking-tight text-white">
                  Request a Topic or Music Vibe
                </h2>
                <p className="mt-1.5 text-sm text-slate-400">
                  Suggest a story for Elena Vance, a synth mood for Marcus Cole, or a cultural
                  topic for Sora Takahashi.
                </p>

                <form onSubmit={handleViewerRequest} className="mt-6 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label
                        htmlFor="viewer-req-channel"
                        className="block text-xs font-medium text-slate-300 mb-1.5"
                      >
                        Channel
                      </label>
                      <select
                        id="viewer-req-channel"
                        value={category}
                        onChange={(e) => setCategory(e.target.value as ChannelCategory)}
                        className="w-full rounded-lg border border-white/10 bg-[#070A10] px-3 py-2 text-xs text-white focus:border-[#E11D48] focus:outline-none"
                      >
                        <option value="news">Global Desk 24 · News</option>
                        <option value="music">Frequency &amp; Form · Music</option>
                        <option value="culture">Signal &amp; Culture · General</option>
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="viewer-req-name"
                        className="block text-xs font-medium text-slate-300 mb-1.5"
                      >
                        Your Name (Optional)
                      </label>
                      <input
                        id="viewer-req-name"
                        type="text"
                        maxLength={40}
                        value={requesterName}
                        onChange={(e) => setRequesterName(e.target.value)}
                        placeholder="Viewer"
                        className="w-full rounded-lg border border-white/10 bg-[#070A10] px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="viewer-req-topic"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Topic or Musical Mood
                    </label>
                    <input
                      id="viewer-req-topic"
                      type="text"
                      maxLength={180}
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      placeholder="e.g., Solar microgrids in East Africa or warm lo-fi synth at 82 BPM"
                      className="w-full rounded-lg border border-white/10 bg-[#070A10] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    <button
                      type="submit"
                      disabled={submitting}
                      className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors"
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{submitting ? 'Submitting…' : 'Send to Show'}</span>
                    </button>

                    {requestFeedback && (
                      <span
                        className={`text-xs ${
                          requestFeedback.ok ? 'text-emerald-300' : 'text-rose-300'
                        }`}
                      >
                        {requestFeedback.text}
                      </span>
                    )}
                  </div>
                </form>
              </div>
            </section>
          </>
        )}
      </main>

      <footer className="border-t border-white/[0.08] bg-[#05070B] py-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-[1440px] flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-4 sm:px-6 text-xs text-slate-500">
          <p>PleziDo TV Viewer App · Watch Live 24/7 on iPhone, Android, Windows &amp; Linux</p>
          <p>Synchronized to UTC Wall Clock</p>
        </div>
      </footer>

      <OfflineIndicator />
    </div>
  );
}
