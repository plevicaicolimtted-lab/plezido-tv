import crypto from 'node:crypto';
import type { Response } from 'express';
import type {
  BroadcastSegment,
  BroadcastSyncState,
  ChannelCategory,
  DraftBroadcastScript,
  HostId,
  ModerationReport,
  ScriptFormat,
  ViewerRequest,
} from '../shared/broadcastTypes.js';
import { screenViewerRequest } from './contentModeration.js';
import {
  draftScriptWithGemini,
  finalizeDraftToBroadcastSegment,
  generateLiveBroadcastSegment,
  isGeminiConfigured,
} from './geminiBroadcast.js';
import { PERMANENT_HOSTS } from './hosts.js';
import { buildDailySchedule, getSlotForTimestamp, HOUR_ROTATION } from './schedule.js';

export { buildDailySchedule };

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
  private lastAiProductionAtMs = 0;

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const nowMs = Date.now();
    const currentSlot = getSlotForTimestamp(nowMs);

    // Seed immediate baseline segments without waiting for external API latency on boot
    const [newsSeg, musicSeg, cultureSeg] = await Promise.all([
      generateLiveBroadcastSegment({
        channel: 'news',
        primaryHostId: 'elena',
        theme: 'Opening Global Desk Bulletin',
        nowMs,
        skipAiProduction: true,
      }),
      generateLiveBroadcastSegment({
        channel: 'music',
        primaryHostId: 'marcus',
        theme: 'Opening Analog Synthesis Set',
        nowMs,
        skipAiProduction: true,
      }),
      generateLiveBroadcastSegment({
        channel: 'culture',
        primaryHostId: 'sora',
        coHostId: 'elena',
        theme: 'Opening Signal & Culture Roundtable',
        nowMs,
        skipAiProduction: true,
      }),
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

    // Immediately upgrade the live stream with a real Gemini free-tier grounded + TTS-voiced segment
    void this.upgradeLiveBroadcastImmediately();
  }

  private async upgradeLiveBroadcastImmediately(): Promise<void> {
    if (!isGeminiConfigured()) return;

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

      this.lastAiProductionAtMs = Date.now();
      this.activateSegment(liveSeg);
    } catch (err) {
      console.warn(
        '[PleziDo TV] Initial live upgrade skipped, continuing baseline feed:',
        err instanceof Error ? err.message : err
      );
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
    try {
      const nowMs = Date.now();
      const remainingMs = this.activeNetworkSegment.endsAtMs - nowMs;

      if (remainingMs <= 18_000 && !this.preparedNextSegment && !this.isProducingNext) {
        void this.prepareNextSegment();
      }

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
            this.activeNetworkSegment.startedAtMs = nowMs;
            this.activeNetworkSegment.endsAtMs = nowMs + this.activeNetworkSegment.durationSec * 1000;
          }
        }
      }
    } catch (err) {
      console.warn(
        '[PleziDo TV] Director tick recovered from error:',
        err instanceof Error ? err.message : err
      );
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

      this.subCycleIndex = (this.subCycleIndex + 1) % HOUR_ROTATION.length;
      const currentSlot = getSlotForTimestamp(Date.now());
      const useSlot =
        this.subCycleIndex === 0 ? currentSlot : HOUR_ROTATION[this.subCycleIndex];

      // Produce a fresh AI segment in background at most once every 3 minutes to respect free-tier quotas;
      // viewer requests and manual studio productions always bypass this throttle.
      const AUTO_AI_INTERVAL_MS = 3 * 60 * 1000;
      const shouldUseAi = Date.now() - this.lastAiProductionAtMs >= AUTO_AI_INTERVAL_MS;

      const seg = await generateLiveBroadcastSegment({
        channel: useSlot.channel,
        primaryHostId: useSlot.hostId,
        coHostId: useSlot.coHostId,
        theme: useSlot.theme,
        nowMs: Date.now(),
        skipAiProduction: !shouldUseAi,
      });

      if (shouldUseAi) {
        this.lastAiProductionAtMs = Date.now();
      }
      this.preparedNextSegment = seg;
    } catch (err) {
      console.warn(
        '[PleziDo TV] Next segment preparation fallback:',
        err instanceof Error ? err.message : err
      );
    } finally {
      this.isProducingNext = false;
      this.broadcast({ type: 'producing', isProducingNext: false });
    }
  }

  private activateSegment(segment: BroadcastSegment): void {
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

  public async writeScriptDraft(options: {
    channel: ChannelCategory;
    primaryHostId: HostId;
    coHostId?: HostId;
    format: ScriptFormat;
    topic: string;
  }): Promise<DraftBroadcastScript> {
    return draftScriptWithGemini({
      ...options,
      throwOnUpstreamError: true,
    });
  }

  public async airDraftedScript(
    draft: DraftBroadcastScript,
    requestedBy?: string
  ): Promise<BroadcastSegment> {
    this.isProducingNext = true;
    this.broadcast({ type: 'producing', isProducingNext: true });

    try {
      const seg = await finalizeDraftToBroadcastSegment(draft, {
        nowMs: Date.now(),
        requestedBy,
      });
      this.activateSegment(seg);
      return seg;
    } finally {
      this.isProducingNext = false;
      this.broadcast({ type: 'producing', isProducingNext: false });
    }
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
      freeTierMode: true,
      geminiConfigured: isGeminiConfigured(),
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
