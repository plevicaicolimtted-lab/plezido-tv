import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BroadcastSegment,
  BroadcastSyncState,
  ChannelCategory,
  ChannelSelection,
  DraftBroadcastScript,
  HostId,
  ModerationReport,
  ScheduleSlot,
  ScriptFormat,
  ViewerRequest,
} from '../shared/broadcastTypes';
import { broadcastAudioEngine } from './audio/broadcastAudioEngine';
import { BroadcastStage } from './components/BroadcastStage';
import { EditorialModerationPanel } from './components/EditorialModerationPanel';
import { HostsRoster } from './components/HostsRoster';
import { OfflineIndicator } from './components/OfflineIndicator';
import { ProgramGuide } from './components/ProgramGuide';
import { ScriptWriterStudio } from './components/ScriptWriterStudio';
import { TopNav } from './components/TopNav';
import { apiUrl } from './lib/apiUrl';

const LazyViewerApp = lazy(() => import('./viewer/ViewerApp'));

export default function App() {
  const isViewerRoute =
    typeof window !== 'undefined' &&
    (window.location.pathname === '/watch' || window.location.pathname.startsWith('/watch/'));

  if (isViewerRoute) {
    return (
      <Suspense fallback={<div className="min-h-screen bg-[#06080D]" />}>
        <LazyViewerApp />
      </Suspense>
    );
  }

  return <StudioApp />;
}

function StudioApp() {
  const [broadcastState, setBroadcastState] = useState<BroadcastSyncState | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<ChannelSelection>('auto');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [streamConnected, setStreamConnected] = useState(false);
  const [statelessMode, setStatelessMode] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const applyLiveSegmentLocally = useCallback((seg: BroadcastSegment) => {
    setBroadcastState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        activeNetworkSegment: seg,
        channelSegments: {
          ...prev.channelSegments,
          [seg.channel]: seg,
        },
        recentSegments: [
          seg,
          ...prev.recentSegments.filter((s) => s.id !== seg.id),
        ].slice(0, 12),
        moderationLog: [
          seg.moderation,
          ...prev.moderationLog.filter((r) => r.id !== seg.moderation.id),
        ].slice(0, 20),
        queue: prev.queue.map((q) =>
          q.status === 'on-air'
            ? { ...q, status: 'aired' }
            : q.segmentId === seg.id
              ? { ...q, status: 'on-air' }
              : q
        ),
        nextTransitionAtMs: seg.endsAtMs,
        isProducingNext: false,
      };
    });
  }, []);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let retryStateTimer: number | null = null;
    let attemptCount = 0;
    let hydrated = false;
    let disposed = false;

    const hydrateInitial = async () => {
      try {
        const res = await fetch(apiUrl('/api/broadcast/state'), { cache: 'no-store' });
        if (!res.ok) throw new Error('Unable to reach PleziDo TV broadcast server');
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
        // Wait through brief cold starts / server restarts before surfacing an error banner
        if (attemptCount >= 3) {
          setLoadError(
            err instanceof Error ? err.message : 'Unable to reach PleziDo TV broadcast server'
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
            isProducingNext?: boolean;
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
                  moderationLog: msg.moderationLog ?? prev.moderationLog,
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
                  moderationLog: msg.moderationLog ?? prev.moderationLog,
                };
              case 'viewers:count':
                return {
                  ...prev,
                  viewerCount: msg.viewerCount ?? prev.viewerCount,
                };
              case 'producing':
                return {
                  ...prev,
                  isProducingNext: msg.isProducingNext ?? prev.isProducingNext,
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

    void hydrateInitial();
    connectStream();

    return () => {
      disposed = true;
      eventSource?.close();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (retryStateTimer !== null) {
        window.clearTimeout(retryStateTimer);
      }
    };
  }, []);

  // Keep 24/7 broadcast rotating cleanly across UTC windows in stateless deployments (e.g. Vercel)
  useEffect(() => {
    if (!broadcastState) return;
    const activeEndsAtMs = broadcastState.activeNetworkSegment.endsAtMs;
    const activeSegId = broadcastState.activeNetworkSegment.id;
    const graceMs = statelessMode ? 600 : 2500;
    const waitMs = Math.max(800, activeEndsAtMs - (Date.now() + clockOffsetMs) + graceMs);

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled) return;

      const queuedItem = statelessMode
        ? broadcastState.queue.find((q) => q.status === 'queued')
        : undefined;

      if (queuedItem) {
        setBroadcastState((prev) =>
          prev
            ? {
                ...prev,
                isProducingNext: true,
                queue: prev.queue.map((q) =>
                  q.id === queuedItem.id ? { ...q, status: 'producing' } : q
                ),
              }
            : prev
        );

        try {
          const res = await fetch(apiUrl('/api/broadcast/produce'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel: queuedItem.category,
              roundtable: false,
              requestedTopic: queuedItem.topic,
              requestedBy: queuedItem.requesterName,
            }),
          });
          if (res.ok) {
            const payload = (await res.json()) as { segment?: BroadcastSegment };
            if (!cancelled && payload.segment) {
              const liveSeg = payload.segment;
              setBroadcastState((prev) =>
                prev
                  ? {
                      ...prev,
                      activeNetworkSegment: liveSeg,
                      channelSegments: {
                        ...prev.channelSegments,
                        [liveSeg.channel]: liveSeg,
                      },
                      recentSegments: [
                        liveSeg,
                        ...prev.recentSegments.filter((s) => s.id !== liveSeg.id),
                      ].slice(0, 12),
                      moderationLog: [
                        liveSeg.moderation,
                        ...prev.moderationLog.filter((r) => r.id !== liveSeg.moderation.id),
                      ].slice(0, 20),
                      queue: prev.queue.map((q) =>
                        q.id === queuedItem.id
                          ? { ...q, status: 'on-air', segmentId: liveSeg.id }
                          : q.status === 'on-air'
                            ? { ...q, status: 'aired' }
                            : q
                      ),
                      nextTransitionAtMs: liveSeg.endsAtMs,
                      isProducingNext: false,
                    }
                  : prev
              );
              return;
            }
          }
        } catch {
          // Fall through to UTC state refresh below
        }
      }

      try {
        const res = await fetch(apiUrl('/api/broadcast/state'), { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const fresh = (await res.json()) as BroadcastSyncState;
        if (cancelled) return;

        setClockOffsetMs(fresh.serverTimeMs - Date.now());
        setStreamConnected(true);
        setBroadcastState((prev) => {
          if (!prev) return fresh;
          if (prev.activeNetworkSegment.id !== activeSegId) {
            return prev;
          }
          return {
            ...fresh,
            queue:
              prev.queue.length > 0
                ? prev.queue.map((q) => (q.status === 'on-air' ? { ...q, status: 'aired' } : q))
                : fresh.queue,
            moderationLog: [
              ...fresh.moderationLog,
              ...prev.moderationLog.filter(
                (r) => !fresh.moderationLog.some((fr) => fr.id === r.id)
              ),
            ].slice(0, 20),
            recentSegments: [
              fresh.activeNetworkSegment,
              ...prev.recentSegments.filter((s) => s.id !== fresh.activeNetworkSegment.id),
            ].slice(0, 12),
          };
        });
      } catch {
        // Keep current state cleanly if poll fails temporarily
      }
    }, waitMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    broadcastState?.activeNetworkSegment.id,
    broadcastState?.activeNetworkSegment.endsAtMs,
    broadcastState?.queue,
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

  // Synchronize Web Audio speech + generative music with the live segment clock
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
    const stageEl = document.getElementById('live-stage');
    stageEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleProduceSegment = useCallback(
    async (channel: ChannelCategory, roundtable: boolean) => {
      setBroadcastState((prev) => (prev ? { ...prev, isProducingNext: true } : prev));
      try {
        const res = await fetch(apiUrl('/api/broadcast/produce'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, roundtable }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          segment?: BroadcastSegment;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error || 'Failed to produce live segment');
        }
        if (data.segment) {
          applyLiveSegmentLocally(data.segment);
        }
        setSelectedChannel('auto');
      } catch (err) {
        setBroadcastState((prev) => (prev ? { ...prev, isProducingNext: false } : prev));
        throw err;
      }
    },
    [applyLiveSegmentLocally]
  );

  const handleSubmitRequest = useCallback(
    async (
      topic: string,
      category: ChannelCategory,
      requesterName: string
    ): Promise<{ accepted: boolean; message: string }> => {
      const res = await fetch(apiUrl('/api/broadcast/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, category, requesterName }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        accepted?: boolean;
        request?: ViewerRequest;
        report?: ModerationReport;
        error?: string;
      };

      if (data.request || data.report) {
        setBroadcastState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            queue: data.request
              ? [data.request, ...prev.queue.filter((q) => q.id !== data.request!.id)].slice(0, 18)
              : prev.queue,
            moderationLog: data.report
              ? [
                  data.report,
                  ...prev.moderationLog.filter((r) => r.id !== data.report!.id),
                ].slice(0, 20)
              : prev.moderationLog,
          };
        });
      }

      if (res.status === 422 && data.report) {
        return {
          accepted: false,
          message: `Blocked before queue: ${data.report.notes}`,
        };
      }
      if (!res.ok) {
        throw new Error(data.error || 'Unable to queue viewer topic.');
      }

      return {
        accepted: true,
        message: `Cleared by editorial gate (${data.report?.notes || 'verified'}). Queued for upcoming broadcast.`,
      };
    },
    []
  );

  const handleWriteScript = useCallback(
    async (params: {
      channel: ChannelCategory;
      primaryHostId: HostId;
      coHostId?: HostId;
      format: ScriptFormat;
      topic: string;
    }): Promise<DraftBroadcastScript> => {
      const res = await fetch(apiUrl('/api/broadcast/write-script'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = (await res.json().catch(() => ({}))) as {
        draft?: DraftBroadcastScript;
        error?: string;
      };
      if (!res.ok || !data.draft) {
        throw new Error(data.error || 'Failed to draft script with Gemini.');
      }
      return data.draft;
    },
    []
  );

  const handleAirScript = useCallback(
    async (draft: DraftBroadcastScript, requestedBy?: string): Promise<void> => {
      setBroadcastState((prev) => (prev ? { ...prev, isProducingNext: true } : prev));
      try {
        const res = await fetch(apiUrl('/api/broadcast/air-script'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft, requestedBy }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          segment?: BroadcastSegment;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error || 'Failed to broadcast drafted script.');
        }
        if (data.segment) {
          applyLiveSegmentLocally(data.segment);
        }
        setSelectedChannel('auto');
      } catch (err) {
        setBroadcastState((prev) => (prev ? { ...prev, isProducingNext: false } : prev));
        throw err;
      }
    },
    [applyLiveSegmentLocally]
  );

  return (
    <div className="min-h-screen bg-[#06080D] text-[#F4F6FA]">
      <TopNav audioEnabled={audioEnabled} onToggleAudio={handleToggleAudio} />

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
              <span className="text-sm text-slate-400">Connecting to PleziDo TV live feed…</span>
            </div>
          </section>
        ) : (
          <>
            <BroadcastStage
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
              isProducingNext={broadcastState.isProducingNext}
              onProduceSegment={handleProduceSegment}
            />

            <ScriptWriterStudio
              hosts={broadcastState.hosts}
              geminiConfigured={broadcastState.geminiConfigured}
              freeTierMode={broadcastState.freeTierMode}
              onWriteScript={handleWriteScript}
              onAirScript={handleAirScript}
            />

            <ProgramGuide
              schedule={broadcastState.schedule}
              hosts={broadcastState.hosts}
              onTuneChannel={handleTuneChannel}
            />

            <HostsRoster
              hosts={broadcastState.hosts}
              activeHostId={displayedSegment.primaryHostId}
              onTuneChannel={handleTuneChannel}
              onLaunchRoundtable={async (channel) => {
                await handleProduceSegment(channel, true);
                handleTuneChannel('auto');
              }}
            />

            <EditorialModerationPanel
              queue={broadcastState.queue}
              moderationLog={broadcastState.moderationLog}
              onSubmitRequest={handleSubmitRequest}
            />
          </>
        )}
      </main>

      <footer className="border-t border-white/[0.08] bg-[#05070B] py-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-[1440px] flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-4 sm:px-6 text-xs text-slate-500">
          <p>
            PleziDo TV · 24/7 Real-Time AI Broadcast Network · iPhone, Android, Windows &amp; Linux
          </p>
          <p>Synchronized to UTC Wall Clock · Real-Time Pre-Broadcast Moderation Active</p>
        </div>
      </footer>

      <OfflineIndicator />
    </div>
  );
}
