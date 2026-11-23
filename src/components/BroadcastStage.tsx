import {
  Captions,
  Download,
  ExternalLink,
  ImagePlus,
  Music,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Tv,
  Users,
  Video,
  Volume2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type {
  BroadcastSegment,
  ChannelCategory,
  ChannelSelection,
  DialogueBeat,
  HostId,
  PermanentHost,
} from '../../shared/broadcastTypes';
import { broadcastAudioEngine } from '../audio/broadcastAudioEngine';
import {
  CartoonBroadcastStage,
  type CartoonStylePreset,
} from './CartoonBroadcastStage';
import { PWAInstallButton } from './PWAInstallButton';

interface BroadcastStageProps {
  segment: BroadcastSegment;
  hosts: PermanentHost[];
  selectedChannel: ChannelSelection;
  onSelectChannel: (channel: ChannelSelection) => void;
  audioEnabled: boolean;
  onEnableAudio: () => void;
  volume: number;
  onVolumeChange: (val: number) => void;
  clockOffsetMs: number;
  viewerCount: number;
  streamConnected: boolean;
  isProducingNext: boolean;
  onProduceSegment: (channel: ChannelCategory, roundtable: boolean) => Promise<void>;
}

function formatClockTime(ms: number, useUtc: boolean): string {
  const d = new Date(ms);
  const h = String(useUtc ? d.getUTCHours() : d.getHours()).padStart(2, '0');
  const m = String(useUtc ? d.getUTCMinutes() : d.getMinutes()).padStart(2, '0');
  const s = String(useUtc ? d.getUTCSeconds() : d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatDuration(sec: number): string {
  const clamped = Math.max(0, Math.floor(sec));
  const mins = Math.floor(clamped / 60);
  const rem = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function moderationLabel(segment: BroadcastSegment): string {
  switch (segment.moderation.verdict) {
    case 'flagged-revised':
      return 'Fact-Checked · Revised Pre-Air';
    case 'cleared-with-caution':
      return 'Editorial Review · Caution Framed';
    case 'blocked':
      return 'Blocked';
    default:
      return segment.isLiveGrounded ? 'Fact-Checked · Search Grounded' : 'Editorial Cleared';
  }
}

export function BroadcastStage({
  segment,
  hosts,
  selectedChannel,
  onSelectChannel,
  audioEnabled,
  onEnableAudio,
  volume,
  onVolumeChange,
  clockOffsetMs,
  viewerCount,
  streamConnected,
  isProducingNext,
  onProduceSegment,
}: BroadcastStageProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now() + clockOffsetMs);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [manualProducing, setManualProducing] = useState(false);
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({});
  const [visualMode, setVisualMode] = useState<'cartoon' | 'studio'>(() => {
    try {
      const saved = window.localStorage.getItem('plezido-visual-mode');
      return saved === 'studio' ? 'studio' : 'cartoon';
    } catch {
      return 'cartoon';
    }
  });
  const [cartoonStyle, setCartoonStyle] = useState<CartoonStylePreset>(() => {
    try {
      const saved = window.localStorage.getItem('plezido-cartoon-style');
      if (saved === 'anime' || saved === 'lofi' || saved === 'cel') return saved;
    } catch {
      // Ignore storage errors
    }
    return 'cel';
  });
  const [customAvatars, setCustomAvatars] = useState<Partial<Record<HostId, string>>>(() => {
    try {
      const raw = window.localStorage.getItem('plezido-custom-avatars');
      return raw ? (JSON.parse(raw) as Partial<Record<HostId, string>>) : {};
    } catch {
      return {};
    }
  });
  const [isRecordingClip, setIsRecordingClip] = useState(false);
  const [recordedClipUrl, setRecordedClipUrl] = useState<string | null>(null);
  const [recordNotice, setRecordNotice] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now() + clockOffsetMs);
    }, 250);
    return () => window.clearInterval(id);
  }, [clockOffsetMs]);

  const elapsedSec = useMemo(() => {
    const raw = (nowMs - segment.startedAtMs) / 1000;
    return Math.max(0, Math.min(segment.durationSec, raw));
  }, [nowMs, segment.startedAtMs, segment.durationSec]);

  const remainingSec = Math.max(0, Math.ceil(segment.durationSec - elapsedSec));

  const activeBeat: DialogueBeat | undefined = useMemo(() => {
    if (segment.dialogueBeats.length === 0) return undefined;
    const found = segment.dialogueBeats.find(
      (b) => elapsedSec >= b.startOffsetSec && elapsedSec < b.startOffsetSec + b.durationSec
    );
    return found ?? segment.dialogueBeats[segment.dialogueBeats.length - 1];
  }, [segment.dialogueBeats, elapsedSec]);

  const speechTotalSec = useMemo(() => {
    if (segment.dialogueBeats.length === 0) return 0;
    const last = segment.dialogueBeats[segment.dialogueBeats.length - 1];
    return last.startOffsetSec + last.durationSec;
  }, [segment.dialogueBeats]);

  const isInMusicInterlude = elapsedSec > speechTotalSec + 0.5;

  const primaryHost = useMemo(
    () => hosts.find((h) => h.id === segment.primaryHostId) ?? hosts[0],
    [hosts, segment.primaryHostId]
  );

  const coHost = useMemo(
    () => (segment.coHostId ? hosts.find((h) => h.id === segment.coHostId) : undefined),
    [hosts, segment.coHostId]
  );

  const activeSpeakerHost = useMemo(() => {
    if (!activeBeat) return primaryHost;
    return hosts.find((h) => h.id === activeBeat.speakerId) ?? primaryHost;
  }, [activeBeat, hosts, primaryHost]);

  // Real-time Web Audio spectrum + voice cadence animation loop
  useEffect(() => {
    let rafId = 0;
    const renderMeters = () => {
      const level = broadcastAudioEngine.getVoiceLevel();
      setVoiceLevel(level);

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.clearRect(0, 0, w, h);
          const bins = broadcastAudioEngine.getSpectrumLevels(20);
          const barW = Math.floor((w - 19 * 3) / 20);
          for (let i = 0; i < 20; i++) {
            const val = audioEnabled
              ? Math.max(0.1, bins[i])
              : 0.12 + 0.25 * Math.abs(Math.sin(Date.now() * 0.003 + i * 0.55));
            const barH = Math.max(3, Math.round(val * (h - 4)));
            ctx.fillStyle =
              segment.channel === 'news'
                ? 'rgba(225, 29, 72, 0.85)'
                : segment.channel === 'music'
                  ? 'rgba(217, 119, 6, 0.85)'
                  : 'rgba(59, 130, 246, 0.85)';
            ctx.fillRect(i * (barW + 3), h - barH, barW, barH);
          }
        }
      }
      rafId = window.requestAnimationFrame(renderMeters);
    };
    rafId = window.requestAnimationFrame(renderMeters);
    return () => window.cancelAnimationFrame(rafId);
  }, [audioEnabled, segment.channel]);

  const cameraAngle = activeBeat?.cameraAngle ?? segment.sceneCue.cameraAngle;
  const backdropTransform =
    cameraAngle === 'anchor-closeup'
      ? 'scale-110 translate-y-[-1%]'
      : cameraAngle === 'split-graphics'
        ? 'scale-105 -translate-x-2'
        : 'scale-100';

  const handleManualProduce = async (roundtable: boolean) => {
    const targetChannel: ChannelCategory =
      selectedChannel === 'auto' ? segment.channel : selectedChannel;
    setManualProducing(true);
    try {
      await onProduceSegment(targetChannel, roundtable);
    } finally {
      setManualProducing(false);
    }
  };

  const handleVisualModeChange = (next: 'cartoon' | 'studio') => {
    setVisualMode(next);
    try {
      window.localStorage.setItem('plezido-visual-mode', next);
    } catch {
      // Ignore storage failures
    }
  };

  const handleCartoonStyleChange = (next: CartoonStylePreset) => {
    setCartoonStyle(next);
    try {
      window.localStorage.setItem('plezido-cartoon-style', next);
    } catch {
      // Ignore storage failures
    }
  };

  const handleAvatarUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const updated: Partial<Record<HostId, string>> = {
        ...customAvatars,
        [primaryHost.id]: reader.result,
      };
      setCustomAvatars(updated);
      setVisualMode('cartoon');
      try {
        window.localStorage.setItem('plezido-visual-mode', 'cartoon');
        window.localStorage.setItem('plezido-custom-avatars', JSON.stringify(updated));
      } catch {
        // Large data URL may exceed localStorage quota; keep in memory for session
      }
    };
    reader.readAsDataURL(file);
  };

  const handleResetAvatar = () => {
    const updated = { ...customAvatars };
    delete updated[primaryHost.id];
    setCustomAvatars(updated);
    try {
      window.localStorage.setItem('plezido-custom-avatars', JSON.stringify(updated));
    } catch {
      // Ignore storage failures
    }
  };

  const handleToggleRecordClip = async () => {
    if (isRecordingClip && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecordingClip(false);
      return;
    }

    const stageCanvas = stageCanvasRef.current;
    if (!stageCanvas || typeof stageCanvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      setRecordNotice('Video clip capture requires a modern desktop or mobile browser.');
      return;
    }

    setRecordNotice(null);
    if (recordedClipUrl) {
      URL.revokeObjectURL(recordedClipUrl);
      setRecordedClipUrl(null);
    }

    const videoStream = stageCanvas.captureStream(30);
    const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
    if (audioEnabled) {
      const audioStream = broadcastAudioEngine.getRecordingAudioStream();
      if (audioStream) {
        tracks.push(...audioStream.getAudioTracks());
      }
    }

    const combinedStream = new MediaStream(tracks);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';

    try {
      const recorder = mimeType
        ? new MediaRecorder(combinedStream, { mimeType })
        : new MediaRecorder(combinedStream);

      recordedChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunksRef.current.push(ev.data);
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        setRecordedClipUrl(url);
        setIsRecordingClip(false);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecordingClip(true);
    } catch {
      setRecordNotice('Unable to start browser video capture in this browser context.');
    }
  };

  return (
    <section id="live-stage" className="mx-auto max-w-[1440px] px-4 sm:px-6 pt-6 pb-10">
      {/* 16:9 Broadcast Stage Frame */}
      <div className="relative overflow-hidden rounded-xl border border-white/[0.1] bg-[#0B0F17]">
        <div className="relative aspect-video w-full min-h-[380px] max-h-[680px] overflow-hidden bg-[#080B11]">
          {/* Studio Scene Layer: Free Unlimited 60fps Cartoon Studio OR Studio Photo */}
          {visualMode === 'cartoon' ? (
            <CartoonBroadcastStage
              segment={segment}
              primaryHost={primaryHost}
              coHost={coHost}
              activeSpeakerId={activeSpeakerHost.id}
              cameraAngle={cameraAngle}
              audioEnabled={audioEnabled}
              isInMusicInterlude={isInMusicInterlude}
              stylePreset={cartoonStyle}
              customAvatars={customAvatars}
              canvasRefExternal={stageCanvasRef}
            />
          ) : !imgErrors[primaryHost.studioSceneUrl] ? (
            <img
              src={primaryHost.studioSceneUrl}
              alt={`${primaryHost.studioName} broadcast set`}
              referrerPolicy="no-referrer"
              onError={() =>
                setImgErrors((prev) => ({ ...prev, [primaryHost.studioSceneUrl]: true }))
              }
              className={`h-full w-full object-cover transition-transform duration-700 ease-out ${backdropTransform}`}
            />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-[#141926] via-[#0B0F17] to-[#1A1320]" />
          )}

          {/* Measured Contrast Scrims */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#06080D] via-[#06080D]/45 to-[#06080D]/60" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#06080D]/75 via-transparent to-[#06080D]/70" />

          {/* Top Broadcast Telemetry Bar */}
          <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div className="flex items-center gap-3 text-xs font-medium text-slate-200">
              <span className="inline-flex items-center gap-2 font-semibold tracking-wide text-white">
                {streamConnected ? (
                  <span className="h-2 w-2 rounded-full bg-[#E11D48] animate-pulse" />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                )}
                <span>{streamConnected ? 'ON AIR' : 'RECONNECTING'}</span>
              </span>
              <span aria-hidden="true" className="text-slate-500">
                ·
              </span>
              <span className="font-mono-tabular text-slate-200">
                UTC {formatClockTime(nowMs, true)}
              </span>
              <span aria-hidden="true" className="hidden sm:inline text-slate-500">
                ·
              </span>
              <span className="hidden sm:inline font-mono-tabular text-slate-300">
                Local {formatClockTime(nowMs, false)}
              </span>
              <span aria-hidden="true" className="hidden md:inline text-slate-500">
                ·
              </span>
              <span className="hidden md:inline font-mono-tabular text-slate-300">
                {viewerCount} watching
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-200">
              <span className="font-semibold text-white">{segment.showTitle}</span>
              <span aria-hidden="true" className="text-slate-500">
                ·
              </span>
              <span className="hidden sm:inline text-slate-300">
                {segment.sceneCue.locationLabel}
              </span>
              <span aria-hidden="true" className="hidden lg:inline text-slate-500">
                ·
              </span>
              <span className="hidden lg:inline-flex items-center gap-1.5 text-emerald-300">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{moderationLabel(segment)}</span>
              </span>
            </div>
          </div>

          {/* Center Studio Stage: Host Frame(s) + Scene Graphic Card */}
          <div className="absolute inset-x-0 top-14 bottom-28 z-10 flex flex-col justify-center px-5 sm:px-8">
            <div className="grid grid-cols-1 lg:grid-cols-12 items-center gap-6">
              {/* Permanent Host Anchor Frame(s) — hidden in Cartoon TV mode so the animated hosts on canvas take center stage */}
              <div className="lg:col-span-7 flex items-end gap-4">
                {visualMode === 'studio' &&
                  [primaryHost, ...(coHost ? [coHost] : [])].map((host) => {
                    const isSpeaking =
                      !isInMusicInterlude && activeSpeakerHost.id === host.id;
                    const pulseScale =
                      isSpeaking && audioEnabled
                        ? 1 + Math.min(0.05, voiceLevel * 0.08)
                        : 1;

                    return (
                      <div
                        key={host.id}
                        className={`relative overflow-hidden rounded-xl border transition-all duration-300 ${
                          isSpeaking
                            ? 'border-white/40 bg-[#0D121D]/90 shadow-2xl'
                            : 'border-white/10 bg-[#0D121D]/70 opacity-75'
                        } ${coHost ? 'w-44 sm:w-56' : 'w-52 sm:w-64'}`}
                        style={{ transform: `scale(${pulseScale})` }}
                      >
                        <div className="relative aspect-square w-full overflow-hidden bg-[#141926]">
                          {!imgErrors[host.portraitUrl] ? (
                            <img
                              src={host.portraitUrl}
                              alt={host.name}
                              referrerPolicy="no-referrer"
                              onError={() =>
                                setImgErrors((prev) => ({ ...prev, [host.portraitUrl]: true }))
                              }
                              className={`h-full w-full object-cover transition-transform duration-700 ${
                                isSpeaking ? 'scale-[1.03]' : 'scale-100'
                              }`}
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#1C2436] to-[#0B0F17] text-2xl font-display font-bold text-slate-300">
                              {host.name
                                .split(' ')
                                .map((n) => n[0])
                                .join('')}
                            </div>
                          )}
                          {isSpeaking && (
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-end gap-0.5 bg-gradient-to-t from-black/70 via-black/20 to-transparent px-3 py-2">
                              {[0.55, 0.9, 0.7, 1, 0.65].map((mult, barIdx) => {
                                const barHeight = Math.max(
                                  4,
                                  Math.round(
                                    (audioEnabled ? Math.max(0.2, voiceLevel) : 0.35) * 18 * mult
                                  )
                                );
                                return (
                                  <span
                                    key={barIdx}
                                    className="w-1 rounded-full bg-[#FB7185] transition-all duration-150"
                                    style={{ height: `${barHeight}px` }}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="border-t border-white/10 px-3 py-2.5 bg-[#090C13]/95">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-white truncate">
                              {host.name}
                            </span>
                            <span
                              className={`text-[11px] font-mono-tabular ${
                                isSpeaking ? 'text-[#FB7185]' : 'text-slate-400'
                              }`}
                            >
                              {isSpeaking ? 'SPEAKING' : 'ON SET'}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-slate-400 truncate">
                            {host.personaTone}
                          </p>
                        </div>
                      </div>
                    );
                  })}

                {/* Scene Action Context Note */}
                {visualMode === 'studio' && (
                  <div className="hidden sm:block max-w-xs pb-2">
                    <p className="text-[11px] font-mono-tabular text-slate-400">
                      Camera · {cameraAngle.replace('-', ' ')}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-300">
                      {isInMusicInterlude
                        ? `Live music showcase · ${segment.musicScore.title}`
                        : activeBeat?.sceneAction || primaryHost.studioName}
                    </p>
                  </div>
                )}
              </div>

              {/* Right-Side Scene Graphic & Live Music Spectrum Card */}
              <div className="hidden md:flex lg:col-span-5 flex-col gap-3 rounded-xl border border-white/10 bg-[#0A0E17]/88 p-5 backdrop-blur-md">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-medium text-slate-400">
                    {segment.sceneCue.visualCardTitle}
                  </span>
                  <span className="font-mono-tabular text-xs font-semibold text-white">
                    {segment.sceneCue.visualCardStat}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-slate-200">
                  {segment.sceneCue.visualCardDetail}
                </p>

                <div className="border-t border-white/10 pt-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 font-medium text-white truncate">
                      <Music className="h-3.5 w-3.5 text-amber-400 shrink-0" aria-hidden="true" />
                      <span className="truncate">{segment.musicScore.title}</span>
                    </span>
                    <span className="font-mono-tabular text-[11px] text-slate-400 shrink-0">
                      {segment.musicScore.bpm} BPM · {segment.musicScore.musicalKey}
                    </span>
                  </div>

                  <canvas
                    ref={canvasRef}
                    width={320}
                    height={36}
                    className="mt-2.5 h-9 w-full rounded bg-[#06080D]/80"
                  />

                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                    <span>{segment.musicScore.genre}</span>
                    <span className="font-mono-tabular">
                      {segment.musicScore.chordProgression.join(' · ')}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Click-to-Unmute Prompt (Non-blocking corner/center action when muted) */}
          {!audioEnabled && (
            <div className="absolute right-6 top-16 z-30">
              <button
                type="button"
                onClick={onEnableAudio}
                className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white shadow-lg hover:bg-[#BE123C] transition-colors whitespace-nowrap shrink-0"
              >
                <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Unmute Live Audio &amp; Music</span>
              </button>
            </div>
          )}

          {/* Synchronized Lower-Third Chyron & Closed Captions */}
          <div className="absolute inset-x-0 bottom-8 z-20 px-5 sm:px-8">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-t border-white/10 pt-3 bg-gradient-to-t from-[#06080D]/95 via-[#06080D]/80 to-transparent pb-2">
              <div className="max-w-3xl">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                  <span className="font-semibold text-white">{activeSpeakerHost.name}</span>
                  <span aria-hidden="true" className="text-slate-500">
                    ·
                  </span>
                  <span>{activeSpeakerHost.role}</span>
                  {segment.requestedBy && (
                    <>
                      <span aria-hidden="true" className="text-slate-500">
                        ·
                      </span>
                      <span className="text-amber-300">
                        Viewer Request by {segment.requestedBy}
                      </span>
                    </>
                  )}
                </div>
                <h1 className="mt-1 font-display text-lg sm:text-2xl font-bold tracking-tight text-white">
                  {segment.headline}
                </h1>
                <p className="mt-0.5 text-xs sm:text-sm text-slate-300 line-clamp-1">
                  {segment.subheadline}
                </p>

                {captionsEnabled && (
                  <p className="mt-2 rounded-md bg-[#06080D]/90 px-3 py-1.5 text-xs sm:text-sm leading-relaxed text-slate-100 border border-white/10">
                    {isInMusicInterlude
                      ? `♪ Now Playing: ${segment.musicScore.title} (${segment.musicScore.mood} · ${segment.musicScore.bpm} BPM)`
                      : activeBeat?.text || segment.summary}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3 text-xs font-mono-tabular text-slate-300 shrink-0">
                <span>Next segment in {formatDuration(remainingSec)}</span>
              </div>
            </div>
          </div>

          {/* Bottom Scrolling Live Broadcast Ticker */}
          <div className="absolute inset-x-0 bottom-0 z-20 h-8 overflow-hidden border-t border-white/10 bg-[#05070B] flex items-center">
            <div className="animate-ticker text-xs font-medium text-slate-300">
              {[...segment.tickerItems, ...segment.tickerItems].map((item, idx) => (
                <span key={idx} className="inline-flex items-center gap-4 px-5 whitespace-nowrap">
                  <span>{item}</span>
                  <span aria-hidden="true" className="text-[#E11D48]">
                    ·
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Stage Control Strip */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-t border-white/[0.08] bg-[#0F131C] px-5 py-3.5">
          {/* Channel Switcher Segmented Controls */}
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-[#090C13] p-1 border border-white/[0.06]">
            {(
              [
                { id: 'auto', label: '24/7 Network' },
                { id: 'news', label: 'News · Elena' },
                { id: 'music', label: 'Music · Marcus' },
                { id: 'culture', label: 'Culture · Sora' },
              ] as Array<{ id: ChannelSelection; label: string }>
            ).map((tab) => {
              const active = selectedChannel === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onSelectChannel(tab.id)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-[#E11D48] text-white'
                      : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Broadcast Controls */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <Volume2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
                aria-label="Broadcast Volume"
                className="h-1.5 w-20 cursor-pointer accent-[#E11D48]"
              />
            </div>

            <button
              type="button"
              onClick={() => setCaptionsEnabled((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                captionsEnabled
                  ? 'border-white/20 bg-white/[0.06] text-white'
                  : 'border-white/10 text-slate-400 hover:text-white'
              }`}
            >
              <Captions className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{captionsEnabled ? 'Captions On' : 'Captions Off'}</span>
            </button>

            <button
              type="button"
              disabled={manualProducing || isProducingNext}
              onClick={() => void handleManualProduce(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#161C29] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E2638] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${manualProducing || isProducingNext ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{manualProducing || isProducingNext ? 'Producing…' : 'New Live Segment'}</span>
            </button>

            <button
              type="button"
              disabled={manualProducing || isProducingNext}
              onClick={() => void handleManualProduce(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#161C29] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E2638] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Dual-Host Roundtable</span>
            </button>

            <PWAInstallButton />
          </div>
        </div>

        {/* Visual Broadcast Mode & Avatar Customization Strip (Zero Billing, Unlimited) */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] bg-[#0C1018] px-5 py-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-1 rounded-lg bg-[#070A10] p-1 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => handleVisualModeChange('cartoon')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  visualMode === 'cartoon'
                    ? 'bg-[#E11D48] text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Tv className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Cartoon TV Mode</span>
              </button>
              <button
                type="button"
                onClick={() => handleVisualModeChange('studio')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  visualMode === 'studio'
                    ? 'bg-white/15 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Studio Photos
              </button>
            </div>

            {visualMode === 'cartoon' && (
              <div className="inline-flex items-center gap-1 rounded-lg bg-[#070A10] p-1 border border-white/[0.06]">
                {(
                  [
                    { id: 'cel', label: 'Broadcast Cel' },
                    { id: 'anime', label: 'Anime Lounge' },
                    { id: 'lofi', label: 'Retro Lo-Fi' },
                  ] as Array<{ id: CartoonStylePreset; label: string }>
                ).map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleCartoonStyleChange(preset.id)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      cartoonStyle === preset.id
                        ? 'bg-[#1E2638] text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarUpload}
              className="sr-only"
              aria-label={`Upload custom avatar for ${primaryHost.name}`}
            />

            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#121722] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-[#1A2232] transition-colors whitespace-nowrap shrink-0"
            >
              <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Set {primaryHost.name.split(' ')[0]} Avatar</span>
            </button>

            {customAvatars[primaryHost.id] && (
              <button
                type="button"
                onClick={handleResetAvatar}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:text-white transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Reset Avatar</span>
              </button>
            )}

            {visualMode === 'cartoon' && (
              <button
                type="button"
                onClick={() => void handleToggleRecordClip()}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isRecordingClip
                    ? 'border-[#E11D48] bg-[#E11D48]/20 text-white'
                    : 'border-white/15 bg-[#121722] text-slate-200 hover:bg-[#1A2232]'
                }`}
              >
                <Video className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isRecordingClip ? 'Stop Recording' : 'Record Video Clip'}</span>
              </button>
            )}

            {recordedClipUrl && (
              <a
                href={recordedClipUrl}
                download={`plezido-tv-${segment.id}.webm`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Save Video (.webm)</span>
              </a>
            )}

            {recordNotice && (
              <span className="text-xs text-amber-300">{recordNotice}</span>
            )}

            <a
              href="/watch"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#161C29] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1E2638] transition-colors whitespace-nowrap shrink-0"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Open Viewer App</span>
            </a>
          </div>
        </div>

        {/* Grounded Verification & Moderation Strip */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-t border-white/[0.06] bg-[#0B0F17] px-5 py-3 text-xs text-slate-400">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <div className="flex items-start sm:items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
              <span>
                <strong className="font-medium text-slate-200">Editorial Gate:</strong>{' '}
                {segment.moderation.notes}
              </span>
            </div>
            <span aria-hidden="true" className="hidden sm:inline text-slate-600">
              ·
            </span>
            <div className="flex items-start sm:items-center gap-2">
              <Radio
                className={`h-4 w-4 shrink-0 mt-0.5 sm:mt-0 ${
                  segment.broadcastEngine.status === 'live-ai-broadcast'
                    ? 'text-emerald-400'
                    : 'text-slate-300'
                }`}
                aria-hidden="true"
              />
              <span>
                <strong className="font-medium text-slate-200">Broadcast Engine:</strong>{' '}
                {segment.broadcastEngine.note}
              </span>
            </div>
          </div>

          {segment.groundingSources.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-slate-500">Verified Sources:</span>
              {segment.groundingSources.map((src, i) => (
                <a
                  key={src.url + i}
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-slate-300 hover:text-white underline decoration-white/20 underline-offset-4"
                >
                  <span className="max-w-[160px] truncate">{src.title}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
