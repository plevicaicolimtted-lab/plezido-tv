import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BroadcastSegment,
  BroadcastSyncState,
  ChannelCategory,
  ChannelSelection,
  ModerationReport,
  ScheduleSlot,
  ViewerRequest,
} from '../shared/broadcastTypes';
import { broadcastAudioEngine } from './audio/broadcastAudioEngine';
import { BroadcastStage } from './components/BroadcastStage';
import { EditorialModerationPanel } from './components/EditorialModerationPanel';
import { HostsRoster } from './components/HostsRoster';
import { OfflineIndicator } from './components/OfflineIndicator';
import { ProgramGuide } from './components/ProgramGuide';
import { TopNav } from './components/TopNav';

export default function App() {
  const [broadcastState, setBroadcastState] = useState<BroadcastSyncState | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<ChannelSelection>('auto');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [streamConnected, setStreamConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const hydrateInitial = async () => {
      try {
        const res = await fetch('/api/broadcast/state');
        if (!res.ok) throw new Error('Unable to reach PleziDo TV broadcast server');
        const data = (await res.json()) as BroadcastSyncState;
        if (!disposed) {
          setClockOffsetMs(data.serverTimeMs - Date.now());
          setBroadcastState(data);
          setLoadError(null);
        }
      } catch (err) {
        if (!disposed) {
          setLoadError(err instanceof Error ? err.message : 'Unable to connect to broadcast.');
        }
      }
    };

    const connectStream = () => {
      if (disposed) return;
      eventSource = new EventSource('/api/broadcast/stream');

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
            setClockOffsetMs(msg.state.serverTimeMs - Date.now());
            setBroadcastState(msg.state);
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
        if (disposed) return;
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
    };
  }, []);

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
      const res = await fetch('/api/broadcast/produce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, roundtable }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || 'Failed to produce live segment');
      }
      setSelectedChannel('auto');
    },
    []
  );

  const handleSubmitRequest = useCallback(
    async (
      topic: string,
      category: ChannelCategory,
      requesterName: string
    ): Promise<{ accepted: boolean; message: string }> => {
      const res = await fetch('/api/broadcast/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, category, requesterName }),
      });
      const data = (await res.json()) as {
        accepted?: boolean;
        report?: ModerationReport;
        error?: string;
      };

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

  return (
    <div className="min-h-screen bg-[#06080D] text-[#F4F6FA]">
      <TopNav audioEnabled={audioEnabled} onToggleAudio={handleToggleAudio} />

      <main>
        {loadError && !broadcastState && (
          <div className="mx-auto max-w-[1440px] px-4 sm:px-6 pt-8">
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-5 text-sm text-rose-200">
              {loadError}
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
