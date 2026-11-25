import {
  ExternalLink,
  MessageSquare,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Send,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  ChannelCategory,
  GroundingSource,
  HostId,
  PermanentHost,
} from '../../shared/broadcastTypes';
import { useFirebase } from '../contexts/FirebaseContext';
import { apiUrl } from '../lib/apiUrl';
import {
  isBrowserSpeechSupported,
  speakWithBrowserVoice,
  stopBrowserVoice,
} from '../lib/browserSpeech';

interface TalkativeAiHostPanelProps {
  hosts: PermanentHost[];
  sectionId?: string;
  activeChannel?: ChannelCategory;
  onTuneChannel?: (channel: ChannelCategory) => void;
  onHostSpeakingChange?: (speaking: boolean, hostId: HostId) => void;
  onSendTopicToShow?: (topic: string, hostId: HostId) => Promise<void>;
}

interface LocalTalkMessage {
  id: string;
  hostId: HostId;
  role: 'user' | 'host';
  text: string;
  audioDataUrl?: string | null;
  voiceModel?: string;
  sources?: GroundingSource[];
  createdAtMs: number;
}

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

const STARTER_PROMPTS: Record<HostId, string[]> = {
  elena: [
    'What major tech or clean energy stories are breaking today?',
    'Explain how PleziDo TV verifies news before going live.',
    'Give me a lively 30-second briefing on AI regulation.',
  ],
  marcus: [
    'What synth chords and BPM fit a midnight city drive?',
    'How do you layer warm Rhodes keys with analog pads?',
    'Tell me about electronic music trends right now.',
  ],
  sora: [
    'How can we prepare our cartoon hosts for future video shows?',
    'Why do studio lighting and architecture shape how viewers listen?',
    'Pitch a fun cultural topic for tonight’s roundtable.',
  ],
};

function float32ToPcm16Base64(input: Float32Array, sourceRate: number, targetRate = 16000): string {
  let samples = input;
  if (sourceRate > targetRate) {
    const ratio = sourceRate / targetRate;
    const newLength = Math.floor(input.length / ratio);
    const resampled = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const idx = Math.floor(i * ratio);
      resampled[i] = input[idx] ?? 0;
    }
    samples = resampled;
  }

  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64Pcm24kToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }
  return float32;
}

function buildLiveWsUrl(hostId: HostId): string {
  const apiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (apiBase && apiBase.trim()) {
    const base = new URL(apiBase.trim());
    const wsProto = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${base.host}/ws/live-host?hostId=${encodeURIComponent(hostId)}`;
  }
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${window.location.host}/ws/live-host?hostId=${encodeURIComponent(hostId)}`;
}

export function TalkativeAiHostPanel({
  hosts,
  sectionId = 'talk-ai',
  activeChannel,
  onTuneChannel,
  onHostSpeakingChange,
  onSendTopicToShow,
}: TalkativeAiHostPanelProps) {
  const { user, talkMessages, saveTalkMessage, clearTalkHistory } = useFirebase();
  const [selectedHostId, setSelectedHostId] = useState<HostId>(() =>
    activeChannel === 'news'
      ? 'elena'
      : activeChannel === 'music'
        ? 'marcus'
        : 'sora'
  );
  const [input, setInput] = useState('');
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(true);
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<LocalTalkMessage[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [queuedIds, setQueuedIds] = useState<Record<string, 'sending' | 'sent' | 'error'>>({});

  // Real-time Gemini 3.8 Live Native Audio Call state
  const [liveCallStatus, setLiveCallStatus] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [liveSpeaking, setLiveSpeaking] = useState(false);
  const [liveDraftInput, setLiveDraftInput] = useState('');
  const [liveDraftOutput, setLiveDraftOutput] = useState('');

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const liveActiveRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeOutputSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const liveInputBufferRef = useRef('');
  const liveOutputBufferRef = useRef('');
  const selectedHostRef = useRef<HostId>(selectedHostId);
  const userRef = useRef(user);

  selectedHostRef.current = selectedHostId;
  userRef.current = user;

  const speechSupported = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
  }, []);

  const activeHost = useMemo(
    () => hosts.find((h) => h.id === selectedHostId) ?? hosts[0],
    [hosts, selectedHostId]
  );

  const visibleMessages: LocalTalkMessage[] = useMemo(() => {
    if (user && talkMessages.length > 0) {
      const audioById = new Map(localMessages.map((m) => [m.id, m]));
      return talkMessages
        .filter((m) => m.hostId === selectedHostId)
        .map((m) => ({
          id: m.id,
          hostId: m.hostId,
          role: m.role,
          text: m.text,
          audioDataUrl: audioById.get(m.id)?.audioDataUrl ?? null,
          voiceModel: audioById.get(m.id)?.voiceModel,
          sources: audioById.get(m.id)?.sources,
          createdAtMs: m.createdAtMs,
        }));
    }
    return localMessages.filter((m) => m.hostId === selectedHostId);
  }, [localMessages, selectedHostId, talkMessages, user]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleMessages.length, sending, liveDraftInput, liveDraftOutput]);

  useEffect(() => {
    if (!activeChannel || liveCallStatus !== 'idle') return;
    const channelHost: HostId =
      activeChannel === 'news' ? 'elena' : activeChannel === 'music' ? 'marcus' : 'sora';
    setSelectedHostId(channelHost);
  }, [activeChannel, liveCallStatus]);

  useEffect(() => {
    const active = liveCallStatus !== 'idle' || playingId !== null;
    onHostSpeakingChange?.(active, selectedHostId);
  }, [liveCallStatus, playingId, selectedHostId, onHostSpeakingChange]);

  const stopAllAudioPlayback = () => {
    audioRef.current?.pause();
    stopBrowserVoice();
    setPlayingId(null);
  };

  const clearScheduledLiveAudio = () => {
    for (const src of activeOutputSourcesRef.current) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already stopped sources
      }
    }
    activeOutputSourcesRef.current.clear();
    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }
    setLiveSpeaking(false);
  };

  const endLiveVoiceCall = () => {
    liveActiveRef.current = false;
    setLiveCallStatus('idle');
    setLiveSpeaking(false);
    setLiveDraftInput('');
    setLiveDraftOutput('');
    liveInputBufferRef.current = '';
    liveOutputBufferRef.current = '';

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      processorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      void inputAudioCtxRef.current.close().catch(() => undefined);
      inputAudioCtxRef.current = null;
    }
    clearScheduledLiveAudio();
    if (outputAudioCtxRef.current) {
      void outputAudioCtxRef.current.close().catch(() => undefined);
      outputAudioCtxRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // Ignore close errors
      }
      wsRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopAllAudioPlayback();
      recognitionRef.current?.stop();
      endLiveVoiceCall();
    };
  }, []);

  const flushLiveTranscripts = () => {
    const hostForTurn = selectedHostRef.current;
    const hostInfo = hosts.find((h) => h.id === hostForTurn) ?? hosts[0];
    const inText = liveInputBufferRef.current.trim();
    const outText = liveOutputBufferRef.current.trim();
    liveInputBufferRef.current = '';
    liveOutputBufferRef.current = '';
    setLiveDraftInput('');
    setLiveDraftOutput('');

    const additions: LocalTalkMessage[] = [];
    if (inText) {
      const uid = `live-u-${Date.now()}`;
      additions.push({
        id: uid,
        hostId: hostForTurn,
        role: 'user',
        text: inText,
        createdAtMs: Date.now(),
      });
      if (userRef.current) {
        void saveTalkMessage({
          id: uid,
          hostId: hostForTurn,
          role: 'user',
          text: inText,
          channel: hostInfo.channel,
        }).catch(() => undefined);
      }
    }
    if (outText) {
      const hid = `live-h-${Date.now() + 1}`;
      additions.push({
        id: hid,
        hostId: hostForTurn,
        role: 'host',
        text: outText,
        voiceModel: 'gemini-3.8-live',
        createdAtMs: Date.now() + 1,
      });
      if (userRef.current) {
        void saveTalkMessage({
          id: hid,
          hostId: hostForTurn,
          role: 'host',
          text: outText,
          channel: hostInfo.channel,
        }).catch(() => undefined);
      }
    }

    if (additions.length > 0) {
      setLocalMessages((prev) => [...prev, ...additions].slice(-40));
    }
  };

  const schedulePcm24kPlayback = (base64Audio: string) => {
    const ctx = outputAudioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const float32 = base64Pcm24kToFloat32(base64Audio);
    if (float32.length === 0) return;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(new Float32Array(float32), 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startTime = Math.max(ctx.currentTime + 0.02, nextStartTimeRef.current);
    nextStartTimeRef.current = startTime + buffer.duration;
    activeOutputSourcesRef.current.add(source);
    setLiveSpeaking(true);

    source.onended = () => {
      activeOutputSourcesRef.current.delete(source);
      if (activeOutputSourcesRef.current.size === 0) {
        setLiveSpeaking(false);
      }
    };
    source.start(startTime);
  };

  const startLiveVoiceCall = async () => {
    if (liveCallStatus !== 'idle') {
      endLiveVoiceCall();
      return;
    }

    stopAllAudioPlayback();
    setErrorText(null);
    setLiveCallStatus('connecting');
    liveActiveRef.current = true;

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

      const outputCtx = new AudioCtx({ sampleRate: 24000 });
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!liveActiveRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micStreamRef.current = stream;

      const inputCtx = new AudioCtx({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;

      const ws = new WebSocket(buildLiveWsUrl(selectedHostId));
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            data?: string;
            text?: string;
            message?: string;
          };

          if (msg.type === 'ready') {
            setLiveCallStatus('live');
          } else if (msg.type === 'audio' && msg.data) {
            schedulePcm24kPlayback(msg.data);
          } else if (msg.type === 'interrupted') {
            clearScheduledLiveAudio();
          } else if (msg.type === 'inputTranscript' && msg.text) {
            liveInputBufferRef.current += msg.text;
            setLiveDraftInput(liveInputBufferRef.current);
          } else if (msg.type === 'outputTranscript' && msg.text) {
            liveOutputBufferRef.current += msg.text;
            setLiveDraftOutput(liveOutputBufferRef.current);
          } else if (msg.type === 'turnComplete') {
            flushLiveTranscripts();
          } else if (msg.type === 'error' && msg.message) {
            setErrorText(msg.message);
          }
        } catch {
          // Ignore malformed WS packets
        }
      };

      ws.onerror = () => {
        setErrorText(
          'Live Voice Call WebSocket unavailable on this host—you can still use Talk + Expressive Voice below.'
        );
        endLiveVoiceCall();
      };

      ws.onclose = () => {
        if (liveActiveRef.current) {
          flushLiveTranscripts();
          endLiveVoiceCall();
        }
      };

      const source = inputCtx.createMediaStreamSource(stream);
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      const silentGain = inputCtx.createGain();
      silentGain.gain.value = 0;

      processor.onaudioprocess = (e) => {
        if (!liveActiveRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          return;
        }
        const channelData = e.inputBuffer.getChannelData(0);
        const base64 = float32ToPcm16Base64(channelData, inputCtx.sampleRate, 16000);
        wsRef.current.send(JSON.stringify({ type: 'audio', data: base64 }));
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(inputCtx.destination);
      processorRef.current = processor;
    } catch (err) {
      setErrorText(
        err instanceof Error
          ? err.message
          : 'Microphone access is required for a Live Voice Call.'
      );
      endLiveVoiceCall();
    }
  };

  const playVoiceReply = (msg: LocalTalkMessage) => {
    stopAllAudioPlayback();

    if (msg.audioDataUrl) {
      const audio = new Audio(msg.audioDataUrl);
      audioRef.current = audio;
      setPlayingId(msg.id);
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => {
        setPlayingId(null);
        speakWithBrowserVoice({
          text: msg.text,
          hostId: msg.hostId,
          onStart: () => setPlayingId(msg.id),
          onEnd: () => setPlayingId(null),
        });
      };
      void audio.play().catch(() => {
        setPlayingId(null);
        speakWithBrowserVoice({
          text: msg.text,
          hostId: msg.hostId,
          onStart: () => setPlayingId(msg.id),
          onEnd: () => setPlayingId(null),
        });
      });
      return;
    }

    speakWithBrowserVoice({
      text: msg.text,
      hostId: msg.hostId,
      onStart: () => setPlayingId(msg.id),
      onEnd: () => setPlayingId(null),
    });
  };

  const sendMessage = async (rawText: string) => {
    const clean = rawText.trim();
    if (clean.length < 2 || sending) return;

    if (liveCallStatus === 'live' && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setInput('');
      wsRef.current.send(JSON.stringify({ type: 'text', text: clean }));
      const uid = `live-txt-${Date.now()}`;
      setLocalMessages((prev) =>
        [
          ...prev,
          {
            id: uid,
            hostId: selectedHostId,
            role: 'user' as const,
            text: clean,
            createdAtMs: Date.now(),
          },
        ].slice(-40)
      );
      if (user) {
        void saveTalkMessage({
          id: uid,
          hostId: selectedHostId,
          role: 'user',
          text: clean,
          channel: activeHost.channel,
        }).catch(() => undefined);
      }
      return;
    }

    setSending(true);
    setErrorText(null);
    setInput('');

    const userMsgId = `msg-u-${Date.now()}`;
    const userMsg: LocalTalkMessage = {
      id: userMsgId,
      hostId: selectedHostId,
      role: 'user',
      text: clean,
      createdAtMs: Date.now(),
    };
    setLocalMessages((prev) => [...prev, userMsg].slice(-40));
    if (user) {
      void saveTalkMessage({
        id: userMsgId,
        hostId: selectedHostId,
        role: 'user',
        text: clean,
        channel: activeHost.channel,
      }).catch(() => undefined);
    }

    try {
      const historyPayload = visibleMessages.slice(-8).map((m) => ({
        role: m.role,
        text: m.text,
      }));

      const res = await fetch(apiUrl('/api/broadcast/talk'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostId: selectedHostId,
          message: clean,
          history: historyPayload,
          withVoice: voiceReplyEnabled,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        replyText?: string;
        audioDataUrl?: string | null;
        voiceModel?: string;
        groundingSources?: GroundingSource[];
        error?: string;
      };

      if (!res.ok || !data.replyText) {
        throw new Error(data.error || 'Unable to talk with the host right now.');
      }

      const hostMsgId = `msg-h-${Date.now()}`;
      const hostMsg: LocalTalkMessage = {
        id: hostMsgId,
        hostId: selectedHostId,
        role: 'host',
        text: data.replyText,
        audioDataUrl: data.audioDataUrl ?? null,
        voiceModel: data.voiceModel,
        sources: data.groundingSources ?? [],
        createdAtMs: Date.now(),
      };
      setLocalMessages((prev) => [...prev, hostMsg].slice(-40));

      if (user) {
        void saveTalkMessage({
          id: hostMsgId,
          hostId: selectedHostId,
          role: 'host',
          text: data.replyText,
          channel: activeHost.channel,
        }).catch(() => undefined);
      }

      if (voiceReplyEnabled) {
        playVoiceReply(hostMsg);
      }
    } catch (err) {
      setErrorText(
        err instanceof Error ? err.message : 'Host chat encountered a temporary issue.'
      );
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendMessage(input);
  };

  const handleToggleMic = () => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };
    const SpeechRec = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SpeechRec) return;

    const rec = new SpeechRec();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      const transcript = ev.results?.[0]?.[0]?.transcript?.trim();
      setListening(false);
      if (transcript) {
        void sendMessage(transcript);
      }
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  };

  const handleClear = async () => {
    setLocalMessages((prev) => prev.filter((m) => m.hostId !== selectedHostId));
    if (user) {
      await clearTalkHistory().catch(() => undefined);
    }
  };

  const canSpeak = isBrowserSpeechSupported();

  return (
    <section
      id={sectionId}
      className="mx-auto max-w-[1440px] px-4 sm:px-6 py-10 border-t border-white/[0.08]"
    >
      <div className="mb-7 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-slate-400">
            Free Forever Sound AI · Gemini 3.8 Live Native Audio &amp; Expressive Voice
          </p>
          <h2 className="mt-1 font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Talk Live With PleziDo TV Hosts
          </h2>
          <p className="mt-1.5 text-sm text-slate-400 max-w-2xl">
            Start a real-time voice-to-voice call (<span className="text-slate-200">gemini-3.8-live</span>) or
            chat with expressive studio TTS (<span className="text-slate-200">gemini-3.8-flash-tts</span>) and
            always-on browser speech fallback—100% free forever.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void startLiveVoiceCall()}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              liveCallStatus === 'live'
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : liveCallStatus === 'connecting'
                  ? 'bg-amber-600 text-white'
                  : 'bg-[#E11D48] text-white hover:bg-[#BE123C]'
            }`}
          >
            {liveCallStatus === 'idle' ? (
              <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <PhoneOff className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>
              {liveCallStatus === 'live'
                ? liveSpeaking
                  ? 'Host Speaking (End Call)'
                  : 'Voice Call Live (End)'
                : liveCallStatus === 'connecting'
                  ? 'Connecting Voice…'
                  : 'Start Live Voice Call'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              const next = !voiceReplyEnabled;
              setVoiceReplyEnabled(next);
              if (!next) stopAllAudioPlayback();
            }}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              voiceReplyEnabled
                ? 'border-white/20 bg-white/[0.06] text-white'
                : 'border-white/10 text-slate-400 hover:text-white'
            }`}
          >
            {voiceReplyEnabled ? (
              <Volume2 className="h-3.5 w-3.5 text-[#FB7185]" aria-hidden="true" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{voiceReplyEnabled ? 'Host Voice On' : 'Text Only'}</span>
          </button>

          {visibleMessages.length > 0 && (
            <button
              type="button"
              onClick={() => void handleClear()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-400 hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Clear Chat</span>
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-4 rounded-xl border border-white/[0.08] bg-[#0B0F17] p-5 space-y-5">
          <div>
            <p className="text-xs font-medium text-slate-400 mb-2.5">Select Talking Host</p>
            <div className="space-y-2">
              {hosts.map((host) => {
                const active = host.id === selectedHostId;
                return (
                  <button
                    key={host.id}
                    type="button"
                    onClick={() => {
                      if (liveCallStatus !== 'idle') {
                        endLiveVoiceCall();
                      }
                      setSelectedHostId(host.id);
                    }}
                    className={`w-full text-left rounded-xl border p-3.5 transition-colors ${
                      active
                        ? 'border-[#E11D48]/70 bg-[#121826]'
                        : 'border-white/[0.07] bg-[#070A10] hover:bg-[#0F1420]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display text-sm font-semibold text-white">
                        {host.name}
                      </span>
                      <span className="text-[11px] font-mono-tabular text-slate-400">
                        {host.showTitle}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400 line-clamp-1">
                      {host.personaTone} · {host.voiceName} Voice
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-white/[0.08] pt-4">
            <p className="text-xs font-medium text-slate-400 mb-2">Quick Conversation Starters</p>
            <div className="space-y-2">
              {STARTER_PROMPTS[selectedHostId].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={sending}
                  onClick={() => void sendMessage(prompt)}
                  className="w-full text-left rounded-lg border border-white/[0.08] bg-[#070A10] px-3 py-2 text-xs text-slate-300 hover:border-white/20 hover:text-white transition-colors disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 rounded-xl border border-white/[0.08] bg-[#0B0F17] overflow-hidden flex flex-col">
          <div className="flex items-center justify-between border-b border-white/[0.08] bg-[#0F131C] px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              <MessageSquare className="h-4 w-4 text-[#E11D48]" aria-hidden="true" />
              <span className="text-sm font-semibold text-white">
                {activeHost.name} · {activeHost.studioName}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {onTuneChannel && (
                <button
                  type="button"
                  onClick={() => onTuneChannel(activeHost.channel)}
                  className="text-xs font-medium text-[#FB7185] hover:text-white transition-colors"
                >
                  Watch Host Live
                </button>
              )}
              <span
                className={`text-xs font-mono-tabular ${
                  liveCallStatus === 'live' ? 'text-emerald-400' : 'text-slate-300'
                }`}
              >
                {liveCallStatus === 'live'
                  ? 'Native 24kHz Voice Active'
                  : 'Free Forever Sound AI'}
              </span>
            </div>
          </div>

          <div
            ref={scrollRef}
            className="h-[340px] overflow-y-auto p-5 space-y-4 bg-[#080B11]"
          >
            {visibleMessages.length === 0 && !liveDraftInput && !liveDraftOutput ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-4">
                <p className="font-display text-base font-semibold text-white">
                  {activeHost.name} is ready to talk in {activeHost.studioName}
                </p>
                <p className="mt-1.5 text-xs text-slate-400 max-w-md leading-relaxed">
                  Click <span className="text-slate-200">Start Live Voice Call</span> to talk hands-free in
                  real time, or type/speak below for expressive studio voice replies.
                </p>
              </div>
            ) : (
              <>
                {visibleMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${
                      msg.role === 'user' ? 'items-end' : 'items-start'
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-[#E11D48] text-white'
                          : 'border border-white/10 bg-[#101624] text-slate-100'
                      }`}
                    >
                      <p className="text-[11px] font-medium opacity-75 mb-1">
                        {msg.role === 'user' ? 'You' : activeHost.name}
                      </p>
                      <p>{msg.text}</p>

                      {msg.role === 'host' && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-3 pt-2 border-t border-white/10">
                          {(msg.audioDataUrl || canSpeak) && (
                            <button
                              type="button"
                              onClick={() => playVoiceReply(msg)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-[#FB7185] hover:text-white transition-colors"
                            >
                              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>
                                {playingId === msg.id
                                  ? 'Speaking…'
                                  : msg.audioDataUrl
                                    ? 'Replay Studio Voice'
                                    : 'Speak Aloud'}
                              </span>
                            </button>
                          )}
                          {onSendTopicToShow && (
                            <button
                              type="button"
                              disabled={queuedIds[msg.id] === 'sending' || queuedIds[msg.id] === 'sent'}
                              onClick={async () => {
                                setQueuedIds((prev) => ({ ...prev, [msg.id]: 'sending' }));
                                try {
                                  await onSendTopicToShow(msg.text.slice(0, 140), selectedHostId);
                                  setQueuedIds((prev) => ({ ...prev, [msg.id]: 'sent' }));
                                } catch {
                                  setQueuedIds((prev) => ({ ...prev, [msg.id]: 'error' }));
                                }
                              }}
                              className={`text-xs font-medium underline decoration-white/20 underline-offset-4 transition-colors ${
                                queuedIds[msg.id] === 'sent'
                                  ? 'text-emerald-300 no-underline'
                                  : queuedIds[msg.id] === 'error'
                                    ? 'text-rose-300'
                                    : 'text-slate-300 hover:text-white'
                              }`}
                            >
                              {queuedIds[msg.id] === 'sending'
                                ? 'Sending to Show…'
                                : queuedIds[msg.id] === 'sent'
                                  ? 'Sent to Live Show Queue'
                                  : queuedIds[msg.id] === 'error'
                                    ? 'Retry Queue'
                                    : 'Queue for On-Air'}
                            </button>
                          )}
                        </div>
                      )}

                      {msg.sources && msg.sources.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                          {msg.sources.map((s, idx) => (
                            <a
                              key={s.url + idx}
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 hover:text-white underline underline-offset-2"
                            >
                              <span className="max-w-[140px] truncate">{s.title}</span>
                              <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {liveDraftInput && (
                  <div className="flex flex-col items-end">
                    <div className="max-w-[85%] rounded-xl bg-[#E11D48]/80 px-4 py-3 text-sm text-white">
                      <p className="text-[11px] opacity-75 mb-1">You (Live Mic)</p>
                      <p>{liveDraftInput}</p>
                    </div>
                  </div>
                )}

                {liveDraftOutput && (
                  <div className="flex flex-col items-start">
                    <div className="max-w-[85%] rounded-xl border border-emerald-500/30 bg-[#101624] px-4 py-3 text-sm text-slate-100">
                      <p className="text-[11px] text-emerald-400 mb-1">
                        {activeHost.name} (Speaking Live)
                      </p>
                      <p>{liveDraftOutput}</p>
                    </div>
                  </div>
                )}
              </>
            )}

            {sending && (
              <div className="flex items-start">
                <div className="rounded-xl border border-white/10 bg-[#101624] px-4 py-3 text-xs text-slate-300">
                  {activeHost.name} is thinking &amp; warming up studio voice…
                </div>
              </div>
            )}
          </div>

          {errorText && (
            <div className="border-t border-rose-500/30 bg-rose-500/10 px-5 py-2.5 text-xs text-rose-200">
              {errorText}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 border-t border-white/[0.08] bg-[#0F131C] p-4"
          >
            <input
              type="text"
              maxLength={500}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                liveCallStatus === 'live'
                  ? `Speak in your mic or type to ${activeHost.name.split(' ')[0]}…`
                  : `Talk to ${activeHost.name.split(' ')[0]} live…`
              }
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#070A10] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
            />

            {speechSupported && liveCallStatus === 'idle' && (
              <button
                type="button"
                onClick={handleToggleMic}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  listening
                    ? 'border-[#E11D48] bg-[#E11D48]/20 text-white'
                    : 'border-white/15 bg-[#161C29] text-slate-200 hover:bg-[#1E2638]'
                }`}
              >
                {listening ? (
                  <MicOff className="h-4 w-4 text-[#FB7185]" aria-hidden="true" />
                ) : (
                  <Mic className="h-4 w-4" aria-hidden="true" />
                )}
                <span>{listening ? 'Listening…' : 'Speak'}</span>
              </button>
            )}

            <button
              type="submit"
              disabled={sending || input.trim().length < 2}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#E11D48] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{sending ? 'Sending…' : 'Talk'}</span>
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
