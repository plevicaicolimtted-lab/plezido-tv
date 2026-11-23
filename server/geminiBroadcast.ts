import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import crypto from 'node:crypto';
import type {
  BroadcastEngineState,
  BroadcastSegment,
  CameraAngle,
  ChannelCategory,
  DialogueBeat,
  DraftBroadcastScript,
  GroundingSource,
  HostId,
  LightingMood,
  MusicScore,
  ScriptFormat,
  SynthPreset,
} from '../shared/broadcastTypes.js';
import {
  auditSegmentBeforeBroadcast,
  buildDefaultModerationReport,
} from './contentModeration.js';
import { getHostById, PERMANENT_HOSTS } from './hosts.js';

const audioCache = new Map<string, Buffer>();
const AUDIO_CACHE_LIMIT = 40;

const groundingCache = new Map<
  string,
  { brief: string; sources: GroundingSource[]; expiresAtMs: number }
>();
const GROUNDING_CACHE_TTL_MS = 15 * 60 * 1000;

let searchCooldownUntilMs = 0;
let textCooldownUntilMs = 0;
let ttsCooldownUntilMs = 0;

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
}

function isRetryableWithLiteError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    isRateLimitError(err) ||
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('high demand') ||
    msg.includes('overloaded')
  );
}

function formatReadableAiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Raw message is already plain text
  }
  return raw;
}

export function isGeminiConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  return Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
}

function getAiClient(): GoogleGenAI | null {
  if (!isGeminiConfigured()) {
    return null;
  }
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function getCachedSegmentAudio(segmentId: string): Buffer | undefined {
  return audioCache.get(segmentId);
}

function storeAudioInCache(segmentId: string, wavBuffer: Buffer): void {
  if (audioCache.size >= AUDIO_CACHE_LIMIT) {
    const oldestKey = audioCache.keys().next().value;
    if (oldestKey) {
      audioCache.delete(oldestKey);
    }
  }
  audioCache.set(segmentId, wavBuffer);
}

function getWavDurationSec(wavBuffer: Buffer): number {
  if (wavBuffer.length <= 44) {
    return 0;
  }
  try {
    const byteRate = wavBuffer.readUInt32LE(28);
    if (byteRate > 0) {
      return Math.max(8, Math.round(((wavBuffer.length - 44) / byteRate) * 10) / 10);
    }
  } catch {
    // Fallback to standard 24kHz 16-bit mono PCM rate
  }
  return Math.max(8, Math.round(((wavBuffer.length - 44) / 48000) * 10) / 10);
}

export interface GenerateSegmentOptions {
  channel: ChannelCategory;
  primaryHostId: HostId;
  coHostId?: HostId;
  theme: string;
  requestedTopic?: string;
  requestedBy?: string;
  nowMs?: number;
}

interface RawAiSegmentPayload {
  headline: string;
  subheadline: string;
  summary: string;
  tickerItems: string[];
  sceneCue: {
    cameraAngle: CameraAngle;
    lightingMood: LightingMood;
    visualCardTitle: string;
    visualCardStat: string;
    visualCardDetail: string;
    locationLabel: string;
  };
  dialogueBeats: Array<{
    speakerId: string;
    text: string;
    sceneAction: string;
    cameraAngle: CameraAngle;
  }>;
  musicScore: {
    title: string;
    genre: string;
    bpm: number;
    musicalKey: string;
    mood: string;
    chordProgression: string[];
    synthPreset: SynthPreset;
    intensity: number;
  };
}

function extractGroundingSources(response: unknown): GroundingSource[] {
  const sources: GroundingSource[] = [];
  const seen = new Set<string>();
  const r = response as {
    candidates?: Array<{
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: { uri?: string; title?: string };
        }>;
      };
    }>;
  };
  const chunks = r?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  for (const chunk of chunks) {
    const uri = chunk?.web?.uri;
    const title = chunk?.web?.title;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      sources.push({
        title: title?.trim() || new URL(uri).hostname,
        url: uri,
      });
    }
    if (sources.length >= 4) break;
  }
  return sources;
}

async function synthesizeSegmentAudio(
  ai: GoogleGenAI,
  segmentId: string,
  primaryHostId: HostId,
  coHostId: HostId | undefined,
  beats: Array<{ speakerId: HostId; text: string }>
): Promise<{ hasAudio: boolean; durationSec: number; wavBuffer?: Buffer }> {
  if (Date.now() < ttsCooldownUntilMs) {
    return { hasAudio: false, durationSec: 0 };
  }

  try {
    const primaryHost = getHostById(primaryHostId);
    const coHost = coHostId ? getHostById(coHostId) : undefined;

    if (coHost && beats.some((b) => b.speakerId === coHost.id)) {
      const parts = beats.map((beat) => {
        const speaker = beat.speakerId === coHost.id ? coHost : primaryHost;
        return {
          text: `${speaker.name.split(' ')[0]}: ${beat.text}`,
          speechMetadata: {
            speaker: speaker.name.split(' ')[0],
            style: speaker.voiceStyle,
          },
        };
      });

      const ttsResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash-tts',
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                {
                  speaker: primaryHost.name.split(' ')[0],
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: primaryHost.voiceName },
                  },
                },
                {
                  speaker: coHost.name.split(' ')[0],
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: coHost.voiceName },
                  },
                },
              ],
            },
          },
        },
      });

      const base64Audio =
        ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const wavBuffer = Buffer.from(base64Audio, 'base64');
        storeAudioInCache(segmentId, wavBuffer);
        return { hasAudio: true, durationSec: getWavDurationSec(wavBuffer), wavBuffer };
      }
    } else {
      const combinedScript = beats.map((b) => b.text).join(' ');
      const ttsResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: combinedScript,
                speechMetadata: {
                  style: primaryHost.voiceStyle,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: primaryHost.voiceName },
            },
          },
        },
      });

      const base64Audio =
        ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const wavBuffer = Buffer.from(base64Audio, 'base64');
        storeAudioInCache(segmentId, wavBuffer);
        return { hasAudio: true, durationSec: getWavDurationSec(wavBuffer), wavBuffer };
      }
    }
  } catch (err) {
    if (isRateLimitError(err)) {
      ttsCooldownUntilMs = Date.now() + 90_000;
    } else {
      console.warn('[PleziDo TV] TTS generation fallback:', err instanceof Error ? err.message : err);
    }
  }
  return { hasAudio: false, durationSec: 0 };
}

function distributeBeatTimings(
  rawBeats: RawAiSegmentPayload['dialogueBeats'],
  primaryHostId: HostId,
  coHostId: HostId | undefined,
  speechDurationSec: number,
  channel: ChannelCategory
): { beats: DialogueBeat[]; totalDurationSec: number; speechEndSec: number } {
  const safeRaw =
    rawBeats.length > 0
      ? rawBeats
      : [
          {
            speakerId: primaryHostId,
            text: 'Welcome back to PleziDo TV live broadcast.',
            sceneAction: 'Anchor looks directly into main studio camera',
            cameraAngle: 'anchor-closeup' as CameraAngle,
          },
        ];

  const charCounts = safeRaw.map((b) => Math.max(20, b.text.trim().length));
  const totalChars = charCounts.reduce((acc, c) => acc + c, 0);

  const estimatedSpeechSec =
    speechDurationSec > 5
      ? speechDurationSec
      : Math.max(28, Math.min(54, Math.round(totalChars / 14)));

  let cursor = 0;
  const beats: DialogueBeat[] = safeRaw.map((beat, idx) => {
    const resolvedSpeaker: HostId =
      coHostId && beat.speakerId === coHostId ? coHostId : primaryHostId;
    const host = getHostById(resolvedSpeaker);
    const share = charCounts[idx] / totalChars;
    const dur = Math.max(4, Math.round(estimatedSpeechSec * share * 10) / 10);
    const angle: CameraAngle =
      beat.cameraAngle === 'wide-studio' ||
      beat.cameraAngle === 'anchor-closeup' ||
      beat.cameraAngle === 'split-graphics'
        ? beat.cameraAngle
        : idx === 0
          ? 'wide-studio'
          : idx % 2 === 1
            ? 'anchor-closeup'
            : 'split-graphics';

    const item: DialogueBeat = {
      id: `beat-${idx + 1}`,
      speakerId: resolvedSpeaker,
      speakerName: host.name,
      text: beat.text.trim(),
      sceneAction: beat.sceneAction?.trim() || `${host.name} presents live on ${host.studioName}`,
      cameraAngle: angle,
      startOffsetSec: Math.round(cursor * 10) / 10,
      durationSec: dur,
    };
    cursor += dur;
    return item;
  });

  const tailSec = channel === 'music' ? 22 : 6;
  const totalDurationSec = Math.max(36, Math.ceil(cursor + tailSec));

  return { beats, totalDurationSec, speechEndSec: cursor };
}

function buildFallbackDraft(options: {
  channel: ChannelCategory;
  primaryHostId: HostId;
  coHostId?: HostId;
  format: ScriptFormat;
  topic: string;
  nowMs: number;
}): DraftBroadcastScript {
  const utcTime = new Date(options.nowMs).toISOString().slice(11, 16);
  const coHost = options.coHostId ? getHostById(options.coHostId) : undefined;
  const topicText = options.topic.trim();

  const presets: Record<
    ChannelCategory,
    Omit<DraftBroadcastScript, 'channel' | 'primaryHostId' | 'coHostId' | 'format' | 'groundingSources' | 'groundedBrief' | 'isLiveGrounded'>
  > = {
    news: {
      headline: topicText
        ? `Live Special Report: ${topicText}`
        : `Global Desk Hour · ${utcTime} UTC Briefing`,
      subheadline: 'Fact-checked world affairs, tech policy & science coverage on PleziDo TV',
      summary:
        'Live anchor briefing covering global infrastructure, clean energy transitions, and technology policy updates.',
      dialogueBeats: [
        {
          speakerId: 'elena',
          text: `Good day from Studio A. It is ${utcTime} UTC, and you are watching Global Desk 24 on PleziDo TV.`,
          sceneAction: 'Wide push-in across the curved newsroom desk',
          cameraAngle: 'wide-studio',
        },
        {
          speakerId: 'elena',
          text: topicText
            ? `Turning right now to a live studio report on ${topicText}, focusing strictly on verified context and measurable developments.`
            : 'Across international bureaus this hour, clean-grid battery storage deployments and AI semiconductor supply chains lead economic policy headlines.',
          sceneAction: 'Medium close-up on Elena Vance with side briefing graphic',
          cameraAngle: 'split-graphics',
        },
        {
          speakerId: coHost ? coHost.id : 'elena',
          text: coHost
            ? `${coHost.name.split(' ')[0]}, from your perspective on ${coHost.expertise.toLowerCase()}, what stands out most here?`
            : 'Stay tuned to PleziDo TV—our editorial desk verifies every bulletin in real time while Frequency and Form continues in Studio B.',
          sceneAction: 'Anchor closeup returning to main camera',
          cameraAngle: 'anchor-closeup',
        },
      ],
      sceneCue: {
        cameraAngle: 'split-graphics',
        lightingMood: 'news-crisp',
        visualCardTitle: 'GLOBAL TECH & POLICY',
        visualCardStat: `${utcTime} UTC`,
        visualCardDetail: 'Fact-checked newsroom feed · Studio A',
        locationLabel: 'LONDON / NEW YORK DESK',
      },
      musicScore: {
        title: 'Broadcast Pulse in D Minor',
        genre: 'Newsroom Ambient Pulse',
        bpm: 96,
        musicalKey: 'D minor',
        mood: 'Focused and steady',
        chordProgression: ['Dm9', 'BbMaj7', 'Gm7', 'A7sus4'],
        synthPreset: 'minimal-pulse',
        intensity: 0.45,
      },
      tickerItems: [
        `PLEZIDO NEWS · ${utcTime} UTC LIVE DESK`,
        'GEMINI FREE-TIER SCRIPTING, VOICE & LIVE BROADCAST ENGINE ACTIVE',
        'STUDIO B: MARCUS COLE LIVE GENERATIVE SYNTH SESSION',
        'PRE-BROADCAST FACT-CHECK GATE ACTIVE ON ALL NEWS BULLETINS',
      ],
    },
    music: {
      headline: topicText
        ? `Studio B Session: ${topicText}`
        : 'Frequency & Form · Late-Night Analog Synthesis',
      subheadline: 'Live generative chord studies and music trend commentary',
      summary:
        'Marcus Cole performs an original real-time harmonic study built around warm Rhodes voicings and tape-filtered pads.',
      dialogueBeats: [
        {
          speakerId: 'marcus',
          text: `Welcome back into Studio B. You are tuned to Frequency and Form with Marcus Cole at ${utcTime} UTC.`,
          sceneAction: 'Warm tungsten light across the modular synth console',
          cameraAngle: 'wide-studio',
        },
        {
          speakerId: 'marcus',
          text: topicText
            ? `Tonight’s live synthesis study is shaped around ${topicText}, running at 84 beats per minute in F minor.`
            : 'For this uninterrupted set, we are blending warm electric piano voicings with slow analog filter sweeps—proof that machines sound better when they breathe.',
          sceneAction: 'Close framing on Marcus Cole at the broadcast console',
          cameraAngle: 'anchor-closeup',
        },
        {
          speakerId: coHost ? coHost.id : 'marcus',
          text: coHost
            ? `${coHost.name.split(' ')[0]}, notice how the harmonic bed settles right underneath the broadcast tempo.`
            : 'Let the chords settle in for the next cycle while the studio meters keep time.',
          sceneAction: 'Split studio shot with live frequency spectrum',
          cameraAngle: 'split-graphics',
        },
      ],
      sceneCue: {
        cameraAngle: 'wide-studio',
        lightingMood: 'synth-warm',
        visualCardTitle: 'LIVE SYNTHESIS SET',
        visualCardStat: '84 BPM · Fm',
        visualCardDetail: 'Analog pad & warm Rhodes broadcast mix',
        locationLabel: 'STUDIO B · SYNTH SUITE',
      },
      musicScore: {
        title: 'Nocturne for Glass & Tape',
        genre: 'Ambient Electronic',
        bpm: 84,
        musicalKey: 'F minor',
        mood: 'Warm nocturnal',
        chordProgression: ['Fm9', 'DbMaj7', 'AbMaj7', 'Eb6'],
        synthPreset: 'warm-rhodes',
        intensity: 0.85,
      },
      tickerItems: [
        'NOW PLAYING IN STUDIO B: NOCTURNE FOR GLASS & TAPE (84 BPM)',
        'FREQUENCY & FORM · 24/7 GENERATIVE MUSIC BROADCAST',
        'NEXT HOUR: SORA TAKAHASHI REPORTS FROM STUDIO C',
      ],
    },
    culture: {
      headline: topicText
        ? `Signal & Culture: ${topicText}`
        : 'Architecture, Design & Everyday Curiosity',
      subheadline: 'General knowledge, design commentary, and live studio conversation',
      summary:
        'Sora Takahashi examines how public architecture, generative acoustics, and modern media shape daily civic spaces.',
      dialogueBeats: [
        {
          speakerId: 'sora',
          text: `Hello and welcome to Studio C! I am Sora Takahashi, broadcasting live on Signal and Culture.`,
          sceneAction: 'Editorial lounge wide shot with warm bookshelf lamps',
          cameraAngle: 'wide-studio',
        },
        {
          speakerId: 'sora',
          text: topicText
            ? `Today we are diving right into ${topicText}—unpacking why it matters and the surprising ideas connecting it to everyday life.`
            : 'Have you noticed how the best modern studios feel less like laboratories and more like quiet libraries? Warm timber and soft light change how people listen.',
          sceneAction: 'Split editorial frame with topic card',
          cameraAngle: 'split-graphics',
        },
        {
          speakerId: coHost ? coHost.id : 'sora',
          text: coHost
            ? `${coHost.name.split(' ')[0]}, I love bringing our studios together on this—what stands out most to you about how live craft builds audience trust?`
            : 'Coming up next on PleziDo TV, we hand back to Studio A for the top-of-the-hour news bulletin.',
          sceneAction: 'Close-up in Studio C lounge',
          cameraAngle: 'anchor-closeup',
        },
      ],
      sceneCue: {
        cameraAngle: 'split-graphics',
        lightingMood: 'amber-lounge',
        visualCardTitle: 'GENERAL KNOWLEDGE & DESIGN',
        visualCardStat: 'STUDIO C',
        visualCardDetail: 'Culture, architecture & everyday media commentary',
        locationLabel: 'TOKYO / LONDON LOUNGE',
      },
      musicScore: {
        title: 'Paper & Lanterns',
        genre: 'Minimal Chamber Ambient',
        bpm: 76,
        musicalKey: 'C major',
        mood: 'Reflective editorial',
        chordProgression: ['CMaj9', 'Am7', 'FMaj7', 'G6'],
        synthPreset: 'ambient-pad',
        intensity: 0.55,
      },
      tickerItems: [
        'SIGNAL & CULTURE WITH SORA TAKAHASHI · STUDIO C',
        '24/7 CONTINUOUS BROADCAST SYNCHRONIZED TO REAL TIME',
        'EXPLORE THE SCRIPT STUDIO TO WRITE & AIR LIVE BROADCASTS',
      ],
    },
  };

  const chosen = presets[options.channel];
  return {
    channel: options.channel,
    primaryHostId: options.primaryHostId,
    coHostId: options.coHostId,
    format: options.format,
    ...chosen,
    groundingSources: [],
    groundedBrief: '',
    isLiveGrounded: false,
  };
}

export async function draftScriptWithGemini(options: {
  channel: ChannelCategory;
  primaryHostId: HostId;
  coHostId?: HostId;
  format: ScriptFormat;
  topic: string;
  requestedBy?: string;
  throwOnUpstreamError?: boolean;
}): Promise<DraftBroadcastScript> {
  const nowMs = Date.now();
  const ai = getAiClient();
  if (!ai) {
    return buildFallbackDraft({ ...options, nowMs });
  }

  if (!options.throwOnUpstreamError && nowMs < textCooldownUntilMs) {
    return buildFallbackDraft({ ...options, nowMs });
  }

  const primaryHost = getHostById(options.primaryHostId);
  const coHost = options.coHostId ? getHostById(options.coHostId) : undefined;
  const isoNow = new Date(nowMs).toISOString();

  try {
    let groundedBrief = '';
    let groundingSources: GroundingSource[] = [];

    const wantsSearch =
      options.channel === 'news' || options.channel === 'culture' || Boolean(options.topic.trim());
    const cacheKey = `${options.channel}:${options.topic.trim().toLowerCase() || 'headline'}`;
    const cachedGrounding = groundingCache.get(cacheKey);

    if (wantsSearch && cachedGrounding && cachedGrounding.expiresAtMs > nowMs) {
      groundedBrief = cachedGrounding.brief;
      groundingSources = cachedGrounding.sources;
    } else if (wantsSearch && nowMs >= searchCooldownUntilMs) {
      const searchPrompt = options.topic.trim()
        ? `Today is ${isoNow}. Research accurate, verified facts and current developments about: "${options.topic.trim()}". Provide 3 concise, factual bullet points suitable for a live television broadcast.`
        : options.channel === 'news'
          ? `Today is ${isoNow}. Summarize 3 top verified breaking global news and technology stories happening right now across world affairs, science, or global markets.`
          : `Today is ${isoNow}. Summarize 2 timely developments in global culture, architecture, music trends, or general knowledge happening right now.`;

      try {
        const searchResponse = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: searchPrompt,
          config: {
            tools: [{ googleSearch: {} }],
          },
        });
        groundedBrief = searchResponse.text?.trim() ?? '';
        groundingSources = extractGroundingSources(searchResponse);
        if (groundedBrief || groundingSources.length > 0) {
          groundingCache.set(cacheKey, {
            brief: groundedBrief,
            sources: groundingSources,
            expiresAtMs: nowMs + GROUNDING_CACHE_TTL_MS,
          });
        }
      } catch (searchErr) {
        if (isRateLimitError(searchErr)) {
          searchCooldownUntilMs = Date.now() + 5 * 60 * 1000;
        } else {
          console.warn(
            '[PleziDo TV] Search grounding unavailable for this cycle:',
            searchErr instanceof Error ? searchErr.message : searchErr
          );
        }
      }
    }

    const hostProfiles = PERMANENT_HOSTS.map(
      (h) =>
        `${h.id} (${h.name}): Tone="${h.personaTone}"; Expertise="${h.expertise}"; Traits=[${h.personaTraits.join(', ')}]; Interaction="${h.interactionStyle}"`
    ).join('\n');

    const coHostDirective = coHost
      ? `Write a natural 2-speaker broadcast conversation alternating between ${primaryHost.id} (${primaryHost.name}) and ${coHost.id} (${coHost.name}) where their distinct personalities bounce off each other naturally.`
      : `All dialogueBeats must be spoken by ${primaryHost.id} (${primaryHost.name}), strongly reflecting their ${primaryHost.personaTone} personality and expertise in ${primaryHost.expertise}.`;

    const structuredPrompt = `You are the live television scriptwriter for PleziDo TV, a 24/7 real-time AI-driven network powered by free-tier Gemini models.
Current UTC timestamp: ${isoNow}
Channel: ${options.channel}
Format: ${options.format}
Show: ${primaryHost.showTitle}
Primary Host: ${primaryHost.id} (${primaryHost.name})
${coHost ? `Co-Host: ${coHost.id} (${coHost.name})` : ''}
Topic / Brief: "${options.topic.trim() || primaryHost.scheduleSummary}"
${options.requestedBy ? `Requested by: ${options.requestedBy}` : ''}
${groundedBrief ? `Verified Real-Time Grounded Facts:\n${groundedBrief}` : ''}

Permanent Host Personas:
${hostProfiles}

Rules:
- Write 3 to 4 crisp, broadcast-ready spoken dialogueBeats totaling ~70 to 110 words total (natural spoken cadence, no stage directions inside spoken text, no markdown).
- Stick strictly to verified facts in the Grounded Facts above; never invent fake stats or quotes.
- ${coHostDirective}
- Specify accurate studio sceneAction and cameraAngle ('wide-studio' | 'anchor-closeup' | 'split-graphics') for each beat so camera cuts match the spoken moment.
- lightingMood must be '${options.channel === 'news' ? 'news-crisp' : options.channel === 'music' ? 'synth-warm' : 'amber-lounge'}'.
- For musicScore: compose real musical metadata (title, genre, bpm between 68 and 126, musicalKey like 'F minor' or 'D minor', chordProgression of 4 standard chord symbols, synthPreset from 'ambient-pad' | 'warm-rhodes' | 'minimal-pulse' | 'deep-dub', intensity 0.35 to 0.95).
- Provide 4 concise tickerItems for the live bottom broadcast ticker.`;

    const scriptResponseSchema = {
      type: Type.OBJECT,
      properties: {
        headline: { type: Type.STRING },
        subheadline: { type: Type.STRING },
        summary: { type: Type.STRING },
        tickerItems: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        sceneCue: {
          type: Type.OBJECT,
          properties: {
            cameraAngle: { type: Type.STRING },
            lightingMood: { type: Type.STRING },
            visualCardTitle: { type: Type.STRING },
            visualCardStat: { type: Type.STRING },
            visualCardDetail: { type: Type.STRING },
            locationLabel: { type: Type.STRING },
          },
          required: [
            'cameraAngle',
            'lightingMood',
            'visualCardTitle',
            'visualCardStat',
            'visualCardDetail',
            'locationLabel',
          ],
        },
        dialogueBeats: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              speakerId: { type: Type.STRING },
              text: { type: Type.STRING },
              sceneAction: { type: Type.STRING },
              cameraAngle: { type: Type.STRING },
            },
            required: ['speakerId', 'text', 'sceneAction', 'cameraAngle'],
          },
        },
        musicScore: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            genre: { type: Type.STRING },
            bpm: { type: Type.NUMBER },
            musicalKey: { type: Type.STRING },
            mood: { type: Type.STRING },
            chordProgression: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            synthPreset: { type: Type.STRING },
            intensity: { type: Type.NUMBER },
          },
          required: [
            'title',
            'genre',
            'bpm',
            'musicalKey',
            'mood',
            'chordProgression',
            'synthPreset',
            'intensity',
          ],
        },
      },
      required: [
        'headline',
        'subheadline',
        'summary',
        'tickerItems',
        'sceneCue',
        'dialogueBeats',
        'musicScore',
      ],
    };

    let structuredResponse;
    try {
      structuredResponse = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: structuredPrompt,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: scriptResponseSchema,
        },
      });
    } catch (primaryErr) {
      if (!isRetryableWithLiteError(primaryErr)) throw primaryErr;
      structuredResponse = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: structuredPrompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: scriptResponseSchema,
        },
      });
    }

    const parsed = JSON.parse((structuredResponse.text ?? '{}').trim()) as RawAiSegmentPayload;

    const validLighting: LightingMood =
      parsed.sceneCue?.lightingMood === 'news-crisp' ||
      parsed.sceneCue?.lightingMood === 'synth-warm' ||
      parsed.sceneCue?.lightingMood === 'amber-lounge'
        ? parsed.sceneCue.lightingMood
        : options.channel === 'news'
          ? 'news-crisp'
          : options.channel === 'music'
            ? 'synth-warm'
            : 'amber-lounge';

    const validPreset: SynthPreset =
      parsed.musicScore?.synthPreset === 'ambient-pad' ||
      parsed.musicScore?.synthPreset === 'warm-rhodes' ||
      parsed.musicScore?.synthPreset === 'minimal-pulse' ||
      parsed.musicScore?.synthPreset === 'deep-dub'
        ? parsed.musicScore.synthPreset
        : options.channel === 'music'
          ? 'warm-rhodes'
          : 'ambient-pad';

    return {
      channel: options.channel,
      primaryHostId: primaryHost.id,
      coHostId: coHost?.id,
      format: options.format,
      headline: parsed.headline || `${primaryHost.showTitle} Live`,
      subheadline: parsed.subheadline || primaryHost.studioName,
      summary: parsed.summary || '',
      tickerItems:
        Array.isArray(parsed.tickerItems) && parsed.tickerItems.length > 0
          ? parsed.tickerItems
          : [`PLEZIDO TV · ${primaryHost.showTitle.toUpperCase()} LIVE`],
      sceneCue: {
        cameraAngle:
          parsed.sceneCue?.cameraAngle === 'wide-studio' ||
          parsed.sceneCue?.cameraAngle === 'anchor-closeup' ||
          parsed.sceneCue?.cameraAngle === 'split-graphics'
            ? parsed.sceneCue.cameraAngle
            : 'split-graphics',
        lightingMood: validLighting,
        visualCardTitle: parsed.sceneCue?.visualCardTitle || primaryHost.showTitle,
        visualCardStat:
          parsed.sceneCue?.visualCardStat || new Date(nowMs).toISOString().slice(11, 16) + ' UTC',
        visualCardDetail: parsed.sceneCue?.visualCardDetail || primaryHost.studioName,
        locationLabel: parsed.sceneCue?.locationLabel || primaryHost.studioName,
      },
      dialogueBeats: (parsed.dialogueBeats ?? []).map((b) => ({
        speakerId: (coHost && b.speakerId === coHost.id ? coHost.id : primaryHost.id) as HostId,
        text: b.text,
        sceneAction: b.sceneAction || primaryHost.studioName,
        cameraAngle:
          b.cameraAngle === 'wide-studio' ||
          b.cameraAngle === 'anchor-closeup' ||
          b.cameraAngle === 'split-graphics'
            ? b.cameraAngle
            : 'anchor-closeup',
      })),
      musicScore: {
        title: parsed.musicScore?.title || 'PleziDo Studio Bed',
        genre: parsed.musicScore?.genre || 'Broadcast Ambient',
        bpm: Math.min(130, Math.max(66, Math.round(parsed.musicScore?.bpm || 86))),
        musicalKey: parsed.musicScore?.musicalKey || 'D minor',
        mood: parsed.musicScore?.mood || 'Atmospheric',
        chordProgression:
          Array.isArray(parsed.musicScore?.chordProgression) &&
          parsed.musicScore.chordProgression.length > 0
            ? parsed.musicScore.chordProgression.slice(0, 4)
            : ['Dm9', 'BbMaj7', 'Gm7', 'A7sus4'],
        synthPreset: validPreset,
        intensity: Math.min(1, Math.max(0.25, parsed.musicScore?.intensity ?? 0.65)),
      },
      groundingSources,
      groundedBrief,
      isLiveGrounded: groundingSources.length > 0 || Boolean(groundedBrief),
    };
  } catch (err) {
    if (isRateLimitError(err)) {
      textCooldownUntilMs = Date.now() + 90_000;
      if (options.throwOnUpstreamError) {
        throw new Error(
          'Gemini free-tier rate limit reached (429). Please wait a moment and try again.'
        );
      }
    } else {
      const readable = formatReadableAiError(err);
      console.warn('[PleziDo TV] Gemini script draft fallback:', readable);
      if (options.throwOnUpstreamError) {
        throw new Error(readable || 'Unable to generate script with Gemini.');
      }
    }
    return buildFallbackDraft({ ...options, nowMs });
  }
}

export async function finalizeDraftToBroadcastSegment(
  draft: DraftBroadcastScript,
  options?: {
    nowMs?: number;
    requestedBy?: string;
    skipAiProduction?: boolean;
  }
): Promise<BroadcastSegment> {
  const nowMs = options?.nowMs ?? Date.now();
  const segmentId = `seg-${crypto.randomUUID().slice(0, 8)}`;
  const primaryHost = getHostById(draft.primaryHostId);
  const coHost = draft.coHostId ? getHostById(draft.coHostId) : undefined;
  const ai = options?.skipAiProduction ? null : getAiClient();

  if (!ai) {
    const { beats, totalDurationSec } = distributeBeatTimings(
      draft.dialogueBeats,
      primaryHost.id,
      coHost?.id,
      0,
      draft.channel
    );
    const engineState: BroadcastEngineState = {
      status: isGeminiConfigured() ? 'live-studio' : 'standby',
      provider: 'gemini-free-tier',
      note: isGeminiConfigured()
        ? 'Gemini Free-Tier Live Studio Stage · Synchronized Score & Anchor Feed'
        : 'Studio scene active · Set GEMINI_API_KEY in Secrets for live Gemini free-tier scripting & voice.',
    };
    return {
      id: segmentId,
      channel: draft.channel,
      primaryHostId: primaryHost.id,
      coHostId: coHost?.id,
      showTitle: primaryHost.showTitle,
      headline: draft.headline,
      subheadline: draft.subheadline,
      summary: draft.summary,
      tickerItems: draft.tickerItems,
      sceneCue: draft.sceneCue,
      dialogueBeats: beats,
      musicScore: draft.musicScore,
      groundingSources: draft.groundingSources,
      moderation: buildDefaultModerationReport(segmentId, draft.channel, draft.headline),
      broadcastEngine: engineState,
      startedAtMs: nowMs,
      durationSec: totalDurationSec,
      endsAtMs: nowMs + totalDurationSec * 1000,
      hasAudio: false,
      audioUrl: null,
      isLiveGrounded: draft.isLiveGrounded,
      requestedBy: options?.requestedBy,
    };
  }

  // Step 1: Real-Time Pre-Broadcast Fact-Checking & Moderation Audit BEFORE TTS
  const audit = await auditSegmentBeforeBroadcast(
    segmentId,
    draft.channel,
    draft.headline,
    draft.subheadline,
    draft.dialogueBeats.map((b) => ({ speakerId: b.speakerId, text: b.text })),
    draft.groundedBrief,
    draft.groundingSources.length
  );

  const auditedRawBeats: RawAiSegmentPayload['dialogueBeats'] = draft.dialogueBeats.map((b, i) => ({
    speakerId: b.speakerId,
    text: audit.revisedBeats[i]?.text ?? b.text,
    sceneAction: b.sceneAction,
    cameraAngle: b.cameraAngle,
  }));

  // Step 2: Synthesize permanent host voice WAV audio via Gemini 3.8 Free-Tier TTS
  const normalizedForTts = auditedRawBeats.map((b) => ({
    speakerId: (coHost && b.speakerId === coHost.id ? coHost.id : primaryHost.id) as HostId,
    text: b.text,
  }));

  const { hasAudio, durationSec: speechSec } = await synthesizeSegmentAudio(
    ai,
    segmentId,
    primaryHost.id,
    coHost?.id,
    normalizedForTts
  );

  const { beats, totalDurationSec } = distributeBeatTimings(
    auditedRawBeats,
    primaryHost.id,
    coHost?.id,
    speechSec,
    draft.channel
  );

  const broadcastEngine: BroadcastEngineState = {
    status: hasAudio ? 'live-ai-broadcast' : 'live-studio',
    provider: 'gemini-free-tier',
    note: hasAudio
      ? 'Gemini Free-Tier Live Broadcast · Voice TTS + Animated Studio Stage'
      : 'Gemini Free-Tier Live Studio Stage · Script & Synchronized Score Active',
  };

  return {
    id: segmentId,
    channel: draft.channel,
    primaryHostId: primaryHost.id,
    coHostId: coHost?.id,
    showTitle: primaryHost.showTitle,
    headline: audit.headline,
    subheadline: audit.subheadline,
    summary: draft.summary,
    tickerItems: draft.tickerItems,
    sceneCue: draft.sceneCue,
    dialogueBeats: beats,
    musicScore: draft.musicScore,
    groundingSources: draft.groundingSources,
    moderation: audit.report,
    broadcastEngine,
    startedAtMs: nowMs,
    durationSec: totalDurationSec,
    endsAtMs: nowMs + totalDurationSec * 1000,
    hasAudio,
    audioUrl: hasAudio ? `/api/broadcast/audio/${segmentId}` : null,
    isLiveGrounded: draft.isLiveGrounded,
    requestedBy: options?.requestedBy,
  };
}

export async function generateLiveBroadcastSegment(
  options: GenerateSegmentOptions & { skipAiProduction?: boolean }
): Promise<BroadcastSegment> {
  const nowMs = options.nowMs ?? Date.now();
  const format: ScriptFormat =
    options.coHostId
      ? 'live-debate'
      : options.channel === 'news'
        ? 'breaking-news'
        : options.channel === 'music'
          ? 'music-intro'
          : 'editorial-essay';

  const draft = options.skipAiProduction
    ? buildFallbackDraft({
        channel: options.channel,
        primaryHostId: options.primaryHostId,
        coHostId: options.coHostId,
        format,
        topic: options.requestedTopic || options.theme,
        nowMs,
      })
    : await draftScriptWithGemini({
        channel: options.channel,
        primaryHostId: options.primaryHostId,
        coHostId: options.coHostId,
        format,
        topic: options.requestedTopic || options.theme,
        requestedBy: options.requestedBy,
      });

  return finalizeDraftToBroadcastSegment(draft, {
    nowMs,
    requestedBy: options.requestedBy,
    skipAiProduction: options.skipAiProduction,
  });
}
