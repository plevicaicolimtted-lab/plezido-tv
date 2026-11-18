import { Mic, Radio, Users, X } from 'lucide-react';
import { useState } from 'react';
import type { ChannelCategory, ChannelSelection, PermanentHost } from '../../shared/broadcastTypes';

interface HostsRosterProps {
  hosts: PermanentHost[];
  activeHostId: string;
  onTuneChannel: (channel: ChannelSelection) => void;
  onLaunchRoundtable: (channel: ChannelCategory) => Promise<void>;
}

export function HostsRoster({
  hosts,
  activeHostId,
  onTuneChannel,
  onLaunchRoundtable,
}: HostsRosterProps) {
  const [selectedHost, setSelectedHost] = useState<PermanentHost | null>(null);
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({});
  const [launching, setLaunching] = useState(false);

  const handleRoundtable = async (channel: ChannelCategory) => {
    setLaunching(true);
    try {
      await onLaunchRoundtable(channel);
      setSelectedHost(null);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section
      id="hosts"
      className="mx-auto max-w-[1440px] px-4 sm:px-6 py-10 border-t border-white/[0.08]"
    >
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7">
        <div>
          <p className="text-xs font-medium text-slate-400">Permanent On-Air Personalities</p>
          <h2 className="mt-1 font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Studio Anchors &amp; Music Directors
          </h2>
        </div>
        <p className="max-w-md text-sm text-slate-400">
          Each permanent host carries a distinct persona, editorial specialty, studio set, and
          synthesized voice across the 24/7 broadcast clock.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {hosts.map((host) => {
          const isOnAir = host.id === activeHostId;
          return (
            <article
              key={host.id}
              className="group flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#0B0F17] transition-colors hover:border-white/20"
            >
              <div className="relative aspect-square w-full overflow-hidden bg-[#121723]">
                {!imgErrors[host.portraitUrl] ? (
                  <img
                    src={host.portraitUrl}
                    alt={`${host.name} — ${host.role}`}
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setImgErrors((prev) => ({ ...prev, [host.portraitUrl]: true }))
                    }
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#1C2436] to-[#0B0F17] text-3xl font-display font-bold text-slate-300">
                    {host.name
                      .split(' ')
                      .map((n) => n[0])
                      .join('')}
                  </div>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#0B0F17] to-transparent" />
              </div>

              <div className="flex flex-1 flex-col p-5">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className={isOnAir ? 'font-semibold text-[#FB7185]' : 'text-slate-300'}>
                    {isOnAir ? 'On Air Now' : host.showTitle}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{host.studioName}</span>
                </div>

                <h3 className="mt-1.5 font-display text-xl font-bold text-white">{host.name}</h3>

                <p className="mt-1 text-xs font-medium text-slate-300">
                  {host.personaTone} · {host.expertise}
                </p>

                <p className="mt-3 text-sm leading-relaxed text-slate-400 flex-1">{host.bio}</p>

                <div className="mt-5 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4 text-xs">
                  <span className="inline-flex items-center gap-1.5 text-slate-400">
                    <Mic className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Voice: {host.voiceName}</span>
                  </span>

                  <button
                    type="button"
                    onClick={() => setSelectedHost(host)}
                    className="font-semibold text-white hover:text-[#FB7185] transition-colors whitespace-nowrap shrink-0"
                  >
                    Inspect Studio &amp; Persona
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {/* Host Persona & Studio Set Modal */}
      {selectedHost && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="host-modal-title"
        >
          <div className="relative w-full max-w-2xl overflow-hidden rounded-xl border border-white/15 bg-[#0D111A] shadow-2xl">
            <button
              type="button"
              onClick={() => setSelectedHost(null)}
              aria-label="Close host profile"
              className="absolute right-4 top-4 z-10 rounded-lg bg-black/60 p-2 text-slate-300 hover:text-white transition-colors"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="relative aspect-video w-full overflow-hidden bg-[#121723]">
              {!imgErrors[selectedHost.studioSceneUrl] ? (
                <img
                  src={selectedHost.studioSceneUrl}
                  alt={selectedHost.studioName}
                  referrerPolicy="no-referrer"
                  onError={() =>
                    setImgErrors((prev) => ({ ...prev, [selectedHost.studioSceneUrl]: true }))
                  }
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full bg-gradient-to-br from-[#1A2133] to-[#0B0F17]" />
              )}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0D111A] via-[#0D111A]/40 to-transparent" />
              <div className="absolute bottom-4 left-6 right-6">
                <p className="text-xs text-slate-300">
                  {selectedHost.showTitle} · {selectedHost.studioName}
                </p>
                <h3 id="host-modal-title" className="mt-1 font-display text-2xl font-bold text-white">
                  {selectedHost.name}
                </h3>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-slate-400">Persona &amp; Tone</p>
                  <p className="mt-1 font-medium text-white">{selectedHost.personaTone}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {selectedHost.personaTraits.join(' · ')}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Area of Expertise</p>
                  <p className="mt-1 font-medium text-white">{selectedHost.expertise}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Vocal Signature: {selectedHost.voiceName}
                  </p>
                </div>
              </div>

              <div className="border-t border-white/[0.08] pt-4">
                <p className="text-xs text-slate-400">On-Air Interaction Style</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-200">
                  {selectedHost.interactionStyle}
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/[0.08] pt-4">
                <button
                  type="button"
                  onClick={() => {
                    onTuneChannel(selectedHost.channel);
                    setSelectedHost(null);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] transition-colors whitespace-nowrap"
                >
                  <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Tune to {selectedHost.showTitle}</span>
                </button>
                <button
                  type="button"
                  disabled={launching}
                  onClick={() => void handleRoundtable(selectedHost.channel)}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-[#161C29] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E2638] disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{launching ? 'Starting…' : 'Launch Dual-Host Roundtable'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
