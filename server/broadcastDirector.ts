import crypto from 'node:crypto';
import type { Response } from 'express';
import type {
  BroadcastSegment,
  BroadcastSyncState,
  ChannelCategory,
  HostId,
  ModerationReport,
  ScheduleSlot,
  ViewerRequest,
} from '../shared/broadcastTypes.js';
import { screenViewerRequest } from './contentModeration.js';
import { generateLiveBroadcastSegment } from './geminiBroadcast.js';
import { PERMANENT_HOSTS } from './hosts.js';

interface HourBlockTemplate {
  channel: ChannelCategory;
  hostId: HostId;
  coHostId?: HostId;
  showTitle: string;
  theme: string;
}

const HOUR_ROTATION: HourBlockTemplate[] = [
  {
    channel: 'news',
    hostId: 'elena',
    showTitle: 'Global Desk 24',
    theme: 'World Headlines, Science & Tech Policy',
  },
  {
    channel: 'music',
    hostId: 'marcus',
    showTitle: 'Frequency & Form',
    theme: 'Continuous Generative Synth & Acoustic Study',
  },
  {
    channel: 'culture',
    hostId: 'sora',
    coHostId: 'elena',
    showTitle: 'Signal & Culture',
    theme: 'Dual-Host Roundtable: Media, Cities & Emerging Tech',
  },
  {
    channel: 'news',
    hostId: 'elena',
    showTitle: 'Global Desk 24',
    theme: 'Global Markets, Infrastructure & Climate Brief',
  },
  {
    channel: 'music',
    hostId: 'marcus',
    coHostId: 'sora',
    showTitle: 'Frequency & Form',
    theme: 'Music Trends & Generative Sound Dialogue',
  },
  {
    channel: 'culture',
    hostId: 'sora',
    showTitle: 'Signal & Culture',
    theme: 'Architecture, Cinema & General Knowledge Dispatch',
  },
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function buildDailySchedule(nowMs: number): ScheduleSlot[] {
  const currentUtcHour = new Date(nowMs).getUTCHours();
  const slots: ScheduleSlot[] = [];

  for (let i = 0; i < 12; i++) {
    const utcHour = (currentUtcHour + i) % 24;
    const nextHour = (utcHour + 1) % 24;
    const tpl = HOUR_ROTATION[utcHour % HOUR_ROTATION.length];
    slots.push({
      id: `slot-utc-${utcHour}`,
      utcHour,
      startLabelUtc: `${pad2(utcHour)}:00`,
      endLabelUtc: `${pad2(nextHour)}:00`,
      channel: tpl.channel,
      hostId: tpl.hostId,
      coHostId: tpl.coHostId,
      showTitle: tpl.showTitle,
      theme: tpl.theme,
      isCurrent: i === 0,
    });
  }
  return slots;
}

function getSlotForTimestamp(nowMs: number): HourBlockTemplate {
  const utcHour = new Date(nowMs).getUTCHours();
  return HOUR_ROTATION[utcHour % HOUR_ROTATION.length];
}

class BroadcastDirector {
  private clients = new Set<Response>();
  private activeNetworkSegment!: BroadcastSegment;
  private channelSegments!: Record<ChannelCategory, BroadcastSegment>;
  private recentSegments: BroadcastSegment[] = [];
  private queue: ViewerRequest[] = [];
  private moderationLog: ModerationReport[] = [];
  private preparedNextSegment: BroadcastSegment | null = null;
  private isProducingNext = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private subCycleIndex = 0;

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const nowMs = Date.now();
    const currentSlot = getSlotForTimestamp(nowMs);

    // Seed immediate baseline segments without waiting for external API latency on boot
    const [newsSeg, musicSeg, cultureSeg] = await Promise.all([
      this.createSeedFallback('news', 'elena', undefined, 'Opening Global Desk Bulletin', nowMs),
      this.createSeedFallback('music', 'marcus', undefined, 'Opening Analog Synthesis Set', nowMs),
      this.createSeedFallback('culture', 'sora', 'elena', 'Opening Signal & Culture Roundtable', nowMs),
    ]);

    this.channelSegments = {
      news: newsSeg,
      music: musicSeg,
      culture: cultureSeg,
    };
    this.activeNetworkSegment = this.channelSegments[currentSlot.channel];
    this.recordModeration(this.activeNetworkSegment.moderation);
    this.recentSegments = [this.activeNetworkSegment];

    this.startLoop();

    // Immediately upgrade the live stream with a real Gemini-grounded + TTS-voiced segment
    void this.upgradeLiveBroadcastImmediately();
  }

  private async createSeedFallback(
    channel: ChannelCategory,
    primaryHostId: HostId,
    coHostId: HostId | undefined,
    theme: string,
    nowMs: number
  ): Promise<BroadcastSegment> {
    // Generate quickly using local fallback when GEMINI_API_KEY is absent, or fast initial seed
    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = '';
    const seg = await generateLiveBroadcastSegment({
      channel,
      primaryHostId,
      coHostId,
      theme,
      nowMs,
    });
    process.env.GEMINI_API_KEY = prevKey;
    return seg;
  }

  private async upgradeLiveBroadcastImmediately(): Promise<void> {
    const nowMs = Date.now();
    const slot = getSlotForTimestamp(nowMs);
    this.isProducingNext = true;
    this.broadcast({ type: 'producing', isProducingNext: true });

    try {
      const liveSeg = await generateLiveBroadcastSegment({
        channel: slot.channel,
        primaryHostId: slot.hostId,
        coHostId: slot.coHostId,
        theme: slot.theme,
        nowMs,
      });

      this.activateSegment(liveSeg);

      // Warm up the other two channel feeds gently in the background
      const otherChannels: Array<{ ch: ChannelCategory; host: HostId; theme: string }> = [
        { ch: 'news', host: 'elena', theme: 'Breaking World & Tech Headlines' },
        { ch: 'music', host: 'marcus', theme: 'Ambient & Electronic Studio Session' },
        { ch: 'culture', host: 'sora', theme: 'Design, Architecture & General Knowledge' },
      ];

      for (const item of otherChannels) {
        if (item.ch !== slot.channel) {
          const chSeg = await generateLiveBroadcastSegment({
            channel: item.ch,
            primaryHostId: item.host,
            theme: item.theme,
            nowMs: Date.now(),
          });
          this.channelSegments[item.ch] = chSeg;
          this.recordModeration(chSeg.moderation);
          this.broadcast({ type: 'channel:updated', channel: item.ch, segment: chSeg });
        }
      }
    } finally {
      this.isProducingNext = false;
      this.broadcast({ type: 'producing', isProducingNext: false });
    }
  }

  private startLoop(): void {
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.loopTimer = setInterval(() => {
      void this.tickDirector();
    }, 1000);

    this.heartbeatTimer = setInterval(() => {
      this.broadcast({
        type: 'clock:sync',
        serverTimeMs: Date.now(),
        viewerCount: Math.max(1, this.clients.size),
      });
    }, 5000);
  }

  private async tickDirector(): Promise<void> {
    const nowMs = Date.now();
    const remainingMs = this.activeNetworkSegment.endsAtMs - nowMs;

    // Pre-produce the next segment 18 seconds before current segment ends
    if (remainingMs <= 18_000 && !this.preparedNextSegment && !this.isProducingNext) {
      void this.prepareNextSegment();
    }

    // Transition exactly when current segment completes
    if (remainingMs <= 0) {
      if (this.preparedNextSegment) {
        const next = this.preparedNextSegment;
        this.preparedNextSegment = null;
        next.startedAtMs = nowMs;
        next.endsAtMs = nowMs + next.durationSec * 1000;
        this.activateSegment(next);
      } else if (!this.isProducingNext) {
        await this.prepareNextSegment();
        const ready = this.preparedNextSegment as BroadcastSegment | null;
        if (ready) {
          this.preparedNextSegment = null;
          ready.startedAtMs = Date.now();
          ready.endsAtMs = ready.startedAtMs + ready.durationSec * 1000;
          this.activateSegment(ready);
        } else {
          // Extend gracefully if production failed
          this.activeNetworkSegment.startedAtMs = nowMs;
          this.activeNetworkSegment.endsAtMs = nowMs + this.activeNetworkSegment.durationSec * 1000;
        }
      }
    }
  }

  private async prepareNextSegment(): Promise<void> {
    if (this.isProducingNext) return;
    this.isProducingNext = true;
    this.broadcast({ type: 'producing', isProducingNext: true });

    try {
      const nextRequest = this.queue.find((q) => q.status === 'queued');
      if (nextRequest) {
        nextRequest.status = 'producing';
        this.broadcast({ type: 'queue:updated', queue: this.queue });

        const hostId: HostId =
          nextRequest.category === 'news'
            ? 'elena'
            : nextRequest.category === 'music'
              ? 'marcus'
              : 'sora';

        const seg = await generateLiveBroadcastSegment({
          channel: nextRequest.category,
          primaryHostId: hostId,
          theme: `Viewer Requested: ${nextRequest.topic}`,
          requestedTopic: nextRequest.topic,
          requestedBy: nextRequest.requesterName,
          nowMs: Date.now(),
        });

        nextRequest.segmentId = seg.id;
        this.preparedNextSegment = seg;
        return;
      }

      // Cycle cleanly across News, Music, Culture, and Dual-Host segments inside the 24/7 loop
      this.subCycleIndex = (this.subCycleIndex + 1) % HOUR_ROTATION.length;
      const currentSlot = getSlotForTimestamp(Date.now());
      const useSlot =
        this.subCycleIndex === 0 ? currentSlot : HOUR_ROTATION[this.subCycleIndex];

      const seg = await generateLiveBroadcastSegment({
        channel: useSlot.channel,
        primaryHostId: useSlot.hostId,
        coHostId: useSlot.coHostId,
        theme: useSlot.theme,
        nowMs: Date.now(),
      });

      this.preparedNextSegment = seg;
    } finally {
      this.isProducingNext = false;
      this.broadcast({ type: 'producing', isProducingNext: false });
    }
  }

  private activateSegment(segment: BroadcastSegment): void {
    // Mark any previous 'on-air' viewer request as 'aired'
    for (const item of this.queue) {
      if (item.status === 'on-air') {
        item.status = 'aired';
      }
      if (item.segmentId === segment.id) {
        item.status = 'on-air';
      }
    }

    this.activeNetworkSegment = segment;
    this.channelSegments[segment.channel] = segment;
    this.recentSegments = [
      segment,
      ...this.recentSegments.filter((s) => s.id !== segment.id),
    ].slice(0, 12);

    this.recordModeration(segment.moderation);

    this.broadcast({
      type: 'segment:live',
      segment,
      channelSegments: this.channelSegments,
      recentSegments: this.recentSegments,
      queue: this.queue,
      moderationLog: this.moderationLog,
      schedule: buildDailySchedule(Date.now()),
      nextTransitionAtMs: segment.endsAtMs,
    });
  }

  private recordModeration(report: ModerationReport): void {
    this.moderationLog = [
      report,
      ...this.moderationLog.filter((r) => r.id !== report.id),
    ].slice(0, 20);
  }

  public async submitViewerRequest(
    topic: string,
    category: ChannelCategory,
    requesterName: string
  ): Promise<{ accepted: boolean; request: ViewerRequest; report: ModerationReport }> {
    const reqId = `req-${crypto.randomUUID().slice(0, 8)}`;
    const cleanTopic = topic.trim().slice(0, 180);
    const cleanName = requesterName.trim().slice(0, 40) || 'Viewer';

    const { allowed, report } = await screenViewerRequest(reqId, cleanTopic, category);
    this.recordModeration(report);

    const requestItem: ViewerRequest = {
      id: reqId,
      topic: cleanTopic,
      category,
      requesterName: cleanName,
      status: allowed ? 'queued' : 'flagged',
      moderationReason: allowed ? undefined : report.notes,
      submittedAtMs: Date.now(),
    };

    this.queue = [requestItem, ...this.queue].slice(0, 18);
    this.broadcast({
      type: 'queue:updated',
      queue: this.queue,
      moderationLog: this.moderationLog,
    });

    // Trigger pre-production right away if nothing is preparing yet
    if (allowed && !this.preparedNextSegment && !this.isProducingNext) {
      void this.prepareNextSegment();
    }

    return { accepted: allowed, request: requestItem, report };
  }

  public async triggerLiveSegmentNow(
    channel: ChannelCategory,
    coHostRoundtable = false
  ): Promise<BroadcastSegment> {
    const primaryHostId: HostId =
      channel === 'news' ? 'elena' : channel === 'music' ? 'marcus' : 'sora';
    const coHostId: HostId | undefined = coHostRoundtable
      ? channel === 'news'
        ? 'sora'
        : channel === 'music'
          ? 'sora'
          : 'elena'
      : undefined;

    this.isProducingNext = true;
    this.broadcast({ type: 'producing', isProducingNext: true });

    try {
      const seg = await generateLiveBroadcastSegment({
        channel,
        primaryHostId,
        coHostId,
        theme: coHostRoundtable
          ? 'Live Dual-Host Roundtable & Analysis'
          : `Live ${channel.toUpperCase()} Broadcast`,
        nowMs: Date.now(),
      });
      this.activateSegment(seg);
      return seg;
    } finally {
      this.isProducingNext = false;
      this.broadcast({ type: 'producing', isProducingNext: false });
    }
  }

  public getState(): BroadcastSyncState {
    const nowMs = Date.now();
    return {
      serverTimeMs: nowMs,
      viewerCount: Math.max(1, this.clients.size),
      activeNetworkSegment: this.activeNetworkSegment,
      channelSegments: this.channelSegments,
      hosts: PERMANENT_HOSTS,
      schedule: buildDailySchedule(nowMs),
      queue: this.queue,
      moderationLog: this.moderationLog,
      recentSegments: this.recentSegments,
      nextTransitionAtMs: this.activeNetworkSegment.endsAtMs,
      isProducingNext: this.isProducingNext,
    };
  }

  public addSseClient(res: Response): void {
    this.clients.add(res);
    this.broadcast({
      type: 'viewers:count',
      viewerCount: Math.max(1, this.clients.size),
    });

    res.on('close', () => {
      this.clients.delete(res);
      this.broadcast({
        type: 'viewers:count',
        viewerCount: Math.max(1, this.clients.size),
      });
    });
  }

  private broadcast(payload: Record<string, unknown>): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export const broadcastDirector = new BroadcastDirector();
