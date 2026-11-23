import {
  Captions,
  ExternalLink,
  Maximize2,
  Minimize2,
  Music,
  Radio,
  Tv,
  Volume2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BroadcastSegment,
  ChannelSelection,
  DialogueBeat,
  PermanentHost,
} from '../../shared/broadcastTypes';
import { broadcastAudioEngine } from '../audio/broadcastAudioEngine';
import {
  CartoonBroadcastStage,
  type CartoonStylePreset,
} from '../components/CartoonBroadcastStage';
import { PWAInstallButton } from '../components/PWAInstallButton';

interface ViewerStageProps {
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

export function ViewerStage({
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
}: ViewerStageProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now() + clockOffsetMs);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [visualMode, setVisualMode] = useState<'cartoon' | 'studio'>(() => {
    try {
      const saved = window.localStorage.getItem('plezido-viewer-visual-mode');
      return saved === 'studio' ? 'studio' : 'cartoon';
    } catch {
      return 'cartoon';
    }
  });
  const [cartoonStyle, setCartoonStyle] = useState<CartoonStylePreset>(() => {
    try {
      const saved = window.localStorage.getItem('plezido-viewer-cartoon-style');
      if (saved === 'anime' || saved === 'lofi' || saved === 'cel') return saved;
    } catch {
      // Ignore storage errors
    }
    return 'cel';
  });

  const playerFrameRef = useRef<HTMLDivElement | null>(null);
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now() + clockOffsetMs);
    }, 250);
    return () => window.clearInterval(id);
  }, [clockOffsetMs]);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

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

  useEffect(() => {
    let rafId = 0;
    const renderMeters = () => {
      const level = broadcastAudioEngine.getVoiceLevel();
      setVoiceLevel(level);

      const canvas = spectrumCanvasRef.current;
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

  const handleToggleVisualMode = (next: 'cartoon' | 'studio') => {
    setVisualMode(next);
    try {
      window.localStorage.setItem('plezido-viewer-visual-mode', next);
    } catch {
      // Ignore storage errors
    }
  };

  const handleStyleChange = (next: CartoonStylePreset) => {
    setCartoonStyle(next);
    try {
      window.localStorage.setItem('plezido-viewer-cartoon-style', next);
    } catch {
      // Ignore storage errors
    }
  };

  const handleToggleFullscreen = async () => {
    const el = playerFrameRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      await el.requestFullscreen?.().catch(() => undefined);
    } else {
      await document.exitFullscreen?.().catch(() => undefined);
    }
  };

  return (
    <section id="watch-live" className="mx-auto max-w-[1440px] px-4 sm:px-6 pt-6 pb-10">
      <div
        ref={playerFrameRef}
        className="relative overflow-hidden rounded-xl border border-white/[0.1] bg-[#0B0F17]"
      >
        <div className="relative aspect-video w-full min-h-[380px] max-h-[720px] overflow-hidden bg-[#080B11]">
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
              customAvatars={{}}
            />
          ) : !imgErrors[primaryHost.studioSceneUrl] ? (
            <img
              src={primaryHost.studioSceneUrl}
              alt={`${primaryHost.studioName} live broadcast`}
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
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#06080D] via-[#06080D]/40 to-[#06080D]/55" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#06080D]/65 via-transparent to-[#06080D]/65" />

          {/* Top Broadcast Overlay */}
          <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div className="flex items-center gap-3 text-xs font-medium text-slate-200">
              <span className="inline-flex items-center gap-2 font-semibold tracking-wide text-white">
                {streamConnected ? (
                  <span className="h-2 w-2 rounded-full bg-[#E11D48] animate-pulse" />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                )}
                <span>{streamConnected ? 'LIVE' : 'SYNCING'}</span>
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
                {viewerCount} watching
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-200">
              <span className="font-semibold text-white">{segment.showTitle}</span>
              <span aria-hidden="true" className="hidden sm:inline text-slate-500">
                ·
              </span>
              <span className="hidden sm:inline text-slate-300">
                {segment.sceneCue.locationLabel}
              </span>
              <button
                type="button"
                onClick={() => void handleToggleFullscreen()}
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Watch fullscreen'}
                className="inline-flex items-center justify-center rounded-md border border-white/15 bg-black/40 p-1.5 text-slate-200 hover:bg-black/70 hover:text-white transition-colors"
              >
                {isFullscreen ? (
                  <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {/* Center Studio Stage */}
          <div className="absolute inset-x-0 top-14 bottom-28 z-10 flex flex-col justify-center px-5 sm:px-8">
            <div className="grid grid-cols-1 lg:grid-cols-12 items-center gap-6">
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
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-[#141926] text-2xl font-display font-bold text-slate-300">
                              {host.name
                                .split(' ')
                                .map((n) => n[0])
                                .join('')}
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
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Right-Side Program Info & Live Audio Spectrum */}
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
                    ref={spectrumCanvasRef}
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

          {!audioEnabled && (
            <div className="absolute right-6 top-16 z-30">
              <button
                type="button"
                onClick={onEnableAudio}
                className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white shadow-lg hover:bg-[#BE123C] transition-colors whitespace-nowrap shrink-0"
              >
                <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Unmute Live Broadcast</span>
              </button>
            </div>
          )}

          {/* Lower-Third Chyron & Closed Captions */}
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
                        Requested by {segment.requestedBy}
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
                <span>Next in {formatDuration(remainingSec)}</span>
              </div>
            </div>
          </div>

          {/* Bottom News & Music Ticker */}
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

        {/* Viewer Remote Control Bar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-t border-white/[0.08] bg-[#0F131C] px-5 py-3.5">
          {/* Channel Surf Switcher */}
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

          {/* Viewer Playback Preferences */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-1 rounded-lg bg-[#090C13] p-1 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => handleToggleVisualMode('cartoon')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  visualMode === 'cartoon'
                    ? 'bg-[#1E2638] text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Tv className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Cartoon TV</span>
              </button>
              <button
                type="button"
                onClick={() => handleToggleVisualMode('studio')}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  visualMode === 'studio'
                    ? 'bg-[#1E2638] text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Studio View
              </button>
            </div>

            {visualMode === 'cartoon' && (
              <div className="hidden sm:inline-flex items-center gap-1 rounded-lg bg-[#090C13] p-1 border border-white/[0.06]">
                {(
                  [
                    { id: 'cel', label: 'Cel' },
                    { id: 'anime', label: 'Anime' },
                    { id: 'lofi', label: 'Lo-Fi' },
                  ] as Array<{ id: CartoonStylePreset; label: string }>
                ).map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleStyleChange(preset.id)}
                    className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      cartoonStyle === preset.id
                        ? 'bg-white/15 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}

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

            <PWAInstallButton />
          </div>
        </div>

        {/* Source Citations Bar (shown only when grounded sources exist) */}
        {segment.groundingSources.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-t border-white/[0.06] bg-[#0B0F17] px-5 py-3 text-xs text-slate-400">
            <span className="text-slate-500">Sources Cited:</span>
            {segment.groundingSources.map((src, i) => (
              <a
                key={src.url + i}
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-slate-300 hover:text-white underline decoration-white/20 underline-offset-4"
              >
                <span className="max-w-[180px] truncate">{src.title}</span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
