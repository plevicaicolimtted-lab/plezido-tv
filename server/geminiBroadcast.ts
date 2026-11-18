import { GoogleGenAI, Type } from '@google/genai';
import crypto from 'node:crypto';
import type {
  BroadcastSegment,
  CameraAngle,
  ChannelCategory,
  DialogueBeat,
  GroundingSource,
  HostId,
  LightingMood,
  MusicScore,
  SynthPreset,
} from '../shared/broadcastTypes.js';
import {
  auditSegmentBeforeBroadcast,
  buildDefaultModerationReport,
} from './contentModeration.js';
import { getHostById, PERMANENT_HOSTS } from './hosts.js';

const audioCache = new Map<string, Buffer>();
const AUDIO_CACHE_LIMIT = 40;

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
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
): Promise<{ hasAudio: boolean; durationSec: number }> {
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
        return { hasAudio: true, durationSec: getWavDurationSec(wavBuffer) };
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
        return { hasAudio: true, durationSec: getWavDurationSec(wavBuffer) };
      }
    }
  } catch (err) {
    console.warn('[PleziDo TV] TTS generation fallback:', err instanceof Error ? err.message : err);
  }
  return { hasAudio: false, durationSec: 0 };
}

function distributeBeatTimings(
  rawBeats: RawAiSegmentPayload['dialogueBeats'],
  primaryHostId: HostId,
  coHostId: HostId | undefined,
  speechDurationSec: number,
  channel: ChannelCategory
): { beats: DialogueBeat[]; totalDurationSec: number } {
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

  return { beats, totalDurationSec };
}

function buildFallbackSegment(options: GenerateSegmentOptions, nowMs: number): BroadcastSegment {
  const primaryHost = getHostById(options.primaryHostId);
  const coHost = options.coHostId ? getHostById(options.coHostId) : undefined;
  const id = `seg-${crypto.randomUUID().slice(0, 8)}`;
  const utcTime = new Date(nowMs).toISOString().slice(11, 16);

  const presetsByChannel: Record<
    ChannelCategory,
    {
      headline: string;
      subheadline: string;
      summary: string;
      beats: RawAiSegmentPayload['dialogueBeats'];
      sceneCue: BroadcastSegment['sceneCue'];
      musicScore: MusicScore;
      tickerItems: string[];
    }
  > = {
    news: {
      headline: options.requestedTopic
        ? `Live Special Report: ${options.requestedTopic}`
        : `Global Desk Hour · ${utcTime} UTC Briefing`,
      subheadline: 'Fact-checked world affairs, tech policy & science coverage on PleziDo TV',
      summary:
        'Live anchor briefing covering global infrastructure, clean energy transitions, and technology policy updates.',
      beats: [
        {
          speakerId: 'elena',
          text: `Good day from Studio A. It is ${utcTime} UTC, and you are watching Global Desk 24 on PleziDo TV.`,
          sceneAction: 'Wide push-in across the curved newsroom desk',
          cameraAngle: 'wide-studio',
        },
        {
          speakerId: 'elena',
          text: options.requestedTopic
            ? `Turning right now to a viewer-requested briefing on ${options.requestedTopic}, looking strictly at verified reporting and technical context.`
            : 'Across international bureaus this hour, clean-grid battery storage deployments and AI semiconductor supply chains lead economic policy headlines.',
          sceneAction: 'Medium close-up on Elena Vance with side briefing graphic',
          cameraAngle: 'split-graphics',
        },
        {
          speakerId: 'elena',
          text: 'Stay tuned to PleziDo TV—our editorial desk verifies every bulletin in real time while Frequency and Form continues in Studio B.',
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
        'PRE-BROADCAST FACT-CHECK GATE ACTIVE ON ALL NEWS BULLETINS',
        'STUDIO B: MARCUS COLE LIVE GENERATIVE SYNTH SESSION AT THE HALF HOUR',
        'SUBMIT A TOPIC REQUEST BELOW TO ENTER THE MODERATED ON-AIR QUEUE',
      ],
    },
    music: {
      headline: options.requestedTopic
        ? `Studio B Session: ${options.requestedTopic}`
        : 'Frequency & Form · Late-Night Analog Synthesis',
      subheadline: 'Live generative chord studies and music trend commentary',
      summary:
        'Marcus Cole performs an original real-time harmonic study built around warm Rhodes voicings and tape-filtered pads.',
      beats: [
        {
          speakerId: 'marcus',
          text: `Welcome back into Studio B. You are tuned to Frequency and Form with Marcus Cole at ${utcTime} UTC.`,
          sceneAction: 'Warm tungsten light across the modular synth console',
          cameraAngle: 'wide-studio',
        },
        {
          speakerId: 'marcus',
          text: options.requestedTopic
            ? `Someone in the booth—meaning you in the queue—asked for ${options.requestedTopic}. So we are dialing up 84 beats per minute in F minor and pretending we planned it all week.`
            : 'For this uninterrupted set, we are blending warm electric piano voicings with slow analog filter sweeps—proof that machines sound better when they breathe.',
          sceneAction: 'Close framing on Marcus Cole at the broadcast console',
          cameraAngle: 'anchor-closeup',
        },
        {
          speakerId: 'marcus',
          text: 'Let the chords settle in for the next cycle while the studio meters keep time.',
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
      headline: options.requestedTopic
        ? `Signal & Culture: ${options.requestedTopic}`
        : 'Architecture, Design & Everyday Curiosity',
      subheadline: 'General knowledge, design commentary, and live studio conversation',
      summary:
        'Sora Takahashi examines how public architecture, generative acoustics, and modern media shape daily civic spaces.',
      beats: [
        {
          speakerId: 'sora',
          text: `Hello and welcome to Studio C! I am Sora Takahashi, broadcasting live on Signal and Culture.`,
          sceneAction: 'Editorial lounge wide shot with warm bookshelf lamps',
          cameraAngle: 'wide-studio',
        },
        {
          speakerId: 'sora',
          text: options.requestedTopic
            ? `Today we are diving right into ${options.requestedTopic}—unpacking why it matters and the surprising ideas connecting it to everyday life.`
            : 'Have you noticed how the best modern studios feel less like laboratories and more like quiet libraries? Warm timber and soft light change how people listen.',
          sceneAction: 'Split editorial frame with topic card',
          cameraAngle: 'split-graphics',
        },
        {
          speakerId: coHost ? coHost.id : 'sora',
          text: coHost
            ? `${coHost.name.split(' ')[0]}, I love bringing Studio A and Studio C together on this—what stands out most to you about how live craft builds audience trust?`
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
        'EXPLORE THE PROGRAM GUIDE BELOW FOR UPCOMING HOST BLOCKS',
      ],
    },
  };

  const chosen = presetsByChannel[options.channel];
  const { beats, totalDurationSec } = distributeBeatTimings(
    chosen.beats,
    options.primaryHostId,
    options.coHostId,
    0,
    options.channel
  );

  return {
    id,
    channel: options.channel,
    primaryHostId: primaryHost.id,
    coHostId: coHost?.id,
    showTitle: primaryHost.showTitle,
    headline: chosen.headline,
    subheadline: chosen.subheadline,
    summary: chosen.summary,
    tickerItems: chosen.tickerItems,
    sceneCue: chosen.sceneCue,
    dialogueBeats: beats,
    musicScore: chosen.musicScore,
    groundingSources: [],
    moderation: buildDefaultModerationReport(id, options.channel, chosen.headline),
    startedAtMs: nowMs,
    durationSec: totalDurationSec,
    endsAtMs: nowMs + totalDurationSec * 1000,
    hasAudio: false,
    audioUrl: null,
    isLiveGrounded: false,
    requestedBy: options.requestedBy,
  };
}

export async function generateLiveBroadcastSegment(
  options: GenerateSegmentOptions
): Promise<BroadcastSegment> {
  const nowMs = options.nowMs ?? Date.now();
  const ai = getAiClient();
  if (!ai) {
    return buildFallbackSegment(options, nowMs);
  }

  const primaryHost = getHostById(options.primaryHostId);
  const coHost = options.coHostId ? getHostById(options.coHostId) : undefined;
  const isoNow = new Date(nowMs).toISOString();
  const segmentId = `seg-${crypto.randomUUID().slice(0, 8)}`;

  try {
    let groundedBrief = '';
    let groundingSources: GroundingSource[] = [];

    // Step 1: Live Google Search Grounding for News, Culture, or Topic Requests
    if (options.channel === 'news' || options.channel === 'culture' || options.requestedTopic) {
      const searchPrompt = options.requestedTopic
        ? `Today is ${isoNow}. Research accurate, verified facts and current developments about: "${options.requestedTopic}". Provide 3 concise, factual bullet points suitable for a live television broadcast.`
        : options.channel === 'news'
          ? `Today is ${isoNow}. Summarize 3 top verified breaking global news and technology stories happening right now across world affairs, science, or global markets. Be factual and concise.`
          : `Today is ${isoNow}. Summarize 2 timely, interesting developments in global culture, architecture, music trends, or general knowledge happening right now for a thoughtful TV feature on "${options.theme}".`;

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
      } catch (searchErr) {
        console.warn(
          '[PleziDo TV] Search grounding skipped:',
          searchErr instanceof Error ? searchErr.message : searchErr
        );
      }
    }

    // Step 2: Structured Live Broadcast Script with Distinct Host Personalities
    const hostProfiles = PERMANENT_HOSTS.map(
      (h) =>
        `${h.id} (${h.name}): Tone="${h.personaTone}"; Expertise="${h.expertise}"; Traits=[${h.personaTraits.join(', ')}]; Interaction="${h.interactionStyle}"`
    ).join('\n');

    const coHostDirective = coHost
      ? `Write a natural 2-speaker broadcast conversation alternating between ${primaryHost.id} (${primaryHost.name}) and ${coHost.id} (${coHost.name}) where their distinct personalities bounce off each other naturally (you may use occasional natural cues like |mhm| or <breath> sparingly in dialogue).`
      : `All dialogueBeats must be spoken by ${primaryHost.id} (${primaryHost.name}), strongly reflecting their ${primaryHost.personaTone} personality and expertise in ${primaryHost.expertise}.`;

    const structuredPrompt = `You are the live television showrunner for PleziDo TV, a 24/7 real-time AI-driven network.
Current UTC timestamp: ${isoNow}
Channel: ${options.channel}
Show: ${primaryHost.showTitle}
Primary Host: ${primaryHost.id} (${primaryHost.name})
${coHost ? `Co-Host: ${coHost.id} (${coHost.name})` : ''}
Segment Theme: ${options.theme}
${options.requestedTopic ? `Viewer Live Request Topic: "${options.requestedTopic}" (Requested by ${options.requestedBy || 'a viewer'})` : ''}
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

    const structuredResponse = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: structuredPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
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
        },
      },
    });

    const parsed = JSON.parse((structuredResponse.text ?? '{}').trim()) as RawAiSegmentPayload;

    // Step 3: Real-Time Pre-Broadcast Fact-Checking & Moderation Audit BEFORE TTS / Airing
    const rawBeatList = (parsed.dialogueBeats ?? []).map((b) => ({
      speakerId: (coHost && b.speakerId === coHost.id ? coHost.id : primaryHost.id) as HostId,
      text: b.text,
      sceneAction: b.sceneAction,
      cameraAngle: b.cameraAngle,
    }));

    const audit = await auditSegmentBeforeBroadcast(
      segmentId,
      options.channel,
      parsed.headline || `${primaryHost.showTitle} Live`,
      parsed.subheadline || primaryHost.studioName,
      rawBeatList.map((b) => ({ speakerId: b.speakerId, text: b.text })),
      groundedBrief,
      groundingSources.length
    );

    const auditedRawBeats: RawAiSegmentPayload['dialogueBeats'] = rawBeatList.map((b, i) => ({
      speakerId: b.speakerId,
      text: audit.revisedBeats[i]?.text ?? b.text,
      sceneAction: b.sceneAction,
      cameraAngle: b.cameraAngle,
    }));

    // Step 4: Synthesize permanent host voice WAV audio via Gemini 3.8 TTS
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
      options.channel
    );

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
      id: segmentId,
      channel: options.channel,
      primaryHostId: primaryHost.id,
      coHostId: coHost?.id,
      showTitle: primaryHost.showTitle,
      headline: audit.headline,
      subheadline: audit.subheadline,
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
      dialogueBeats: beats,
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
      moderation: audit.report,
      startedAtMs: nowMs,
      durationSec: totalDurationSec,
      endsAtMs: nowMs + totalDurationSec * 1000,
      hasAudio,
      audioUrl: hasAudio ? `/api/broadcast/audio/${segmentId}` : null,
      isLiveGrounded: groundingSources.length > 0 || Boolean(groundedBrief),
      requestedBy: options.requestedBy,
    };
  } catch (err) {
    console.error('[PleziDo TV] Segment generation error, using resilient fallback:', err);
    return buildFallbackSegment(options, nowMs);
  }
}
