import type { BroadcastSegment, BroadcastSyncState } from '../shared/broadcastTypes.js';
import { generateLiveBroadcastSegment, isGeminiConfigured } from './geminiBroadcast.js';
import { PERMANENT_HOSTS } from './hosts.js';
import { buildDailySchedule, HOUR_ROTATION } from './schedule.js';

const SEGMENT_WINDOW_MS = 45_000;

export async function buildStatelessBroadcastState(
  nowMs = Date.now()
): Promise<BroadcastSyncState> {
  const windowIndex = Math.floor(nowMs / SEGMENT_WINDOW_MS);
  const windowStartMs = windowIndex * SEGMENT_WINDOW_MS;
  const activeSlot = HOUR_ROTATION[windowIndex % HOUR_ROTATION.length];

  const [newsSeg, musicSeg, cultureSeg] = await Promise.all([
    generateLiveBroadcastSegment({
      channel: 'news',
      primaryHostId: 'elena',
      theme: 'World Headlines, Science & Tech Policy',
      nowMs: windowStartMs,
      skipAiProduction: true,
    }),
    generateLiveBroadcastSegment({
      channel: 'music',
      primaryHostId: 'marcus',
      theme: 'Continuous Generative Synth & Acoustic Study',
      nowMs: windowStartMs,
      skipAiProduction: true,
    }),
    generateLiveBroadcastSegment({
      channel: 'culture',
      primaryHostId: 'sora',
      coHostId: 'elena',
      theme: 'Dual-Host Roundtable: Media, Cities & Emerging Tech',
      nowMs: windowStartMs,
      skipAiProduction: true,
    }),
  ]);

  let activeNetworkSegment: BroadcastSegment;
  if (activeSlot.coHostId) {
    activeNetworkSegment = await generateLiveBroadcastSegment({
      channel: activeSlot.channel,
      primaryHostId: activeSlot.hostId,
      coHostId: activeSlot.coHostId,
      theme: activeSlot.theme,
      nowMs: windowStartMs,
      skipAiProduction: true,
    });
  } else {
    activeNetworkSegment =
      activeSlot.channel === 'news'
        ? newsSeg
        : activeSlot.channel === 'music'
          ? musicSeg
          : cultureSeg;
  }

  activeNetworkSegment = {
    ...activeNetworkSegment,
    id: `seg-utc-${windowIndex}`,
    startedAtMs: windowStartMs,
    durationSec: SEGMENT_WINDOW_MS / 1000,
    endsAtMs: windowStartMs + SEGMENT_WINDOW_MS,
  };

  const channelSegments = {
    news:
      activeNetworkSegment.channel === 'news'
        ? activeNetworkSegment
        : {
            ...newsSeg,
            id: `seg-news-${windowIndex}`,
            startedAtMs: windowStartMs,
            durationSec: SEGMENT_WINDOW_MS / 1000,
            endsAtMs: windowStartMs + SEGMENT_WINDOW_MS,
          },
    music:
      activeNetworkSegment.channel === 'music'
        ? activeNetworkSegment
        : {
            ...musicSeg,
            id: `seg-music-${windowIndex}`,
            startedAtMs: windowStartMs,
            durationSec: SEGMENT_WINDOW_MS / 1000,
            endsAtMs: windowStartMs + SEGMENT_WINDOW_MS,
          },
    culture:
      activeNetworkSegment.channel === 'culture'
        ? activeNetworkSegment
        : {
            ...cultureSeg,
            id: `seg-culture-${windowIndex}`,
            startedAtMs: windowStartMs,
            durationSec: SEGMENT_WINDOW_MS / 1000,
            endsAtMs: windowStartMs + SEGMENT_WINDOW_MS,
          },
  };

  return {
    serverTimeMs: nowMs,
    viewerCount: 1,
    activeNetworkSegment,
    channelSegments,
    hosts: PERMANENT_HOSTS,
    schedule: buildDailySchedule(nowMs),
    queue: [],
    moderationLog: [activeNetworkSegment.moderation],
    recentSegments: [activeNetworkSegment],
    nextTransitionAtMs: activeNetworkSegment.endsAtMs,
    isProducingNext: false,
    freeTierMode: true,
    geminiConfigured: isGeminiConfigured(),
  };
}
