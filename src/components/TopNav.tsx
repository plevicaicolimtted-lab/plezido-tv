import { Volume2, VolumeX } from 'lucide-react';

interface TopNavProps {
  audioEnabled: boolean;
  onToggleAudio: () => void;
}

export function TopNav({ audioEnabled, onToggleAudio }: TopNavProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-[#06080D]/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-3.5">
        <a
          href="#live-stage"
          className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          PleziDo TV
        </a>

        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
          <a
            href="#live-stage"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Live Stage
          </a>
          <a
            href="#program-guide"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Program Guide
          </a>
          <a
            href="#hosts"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Hosts
          </a>
          <a
            href="#editorial-desk"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Editorial Desk
          </a>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onToggleAudio}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E11D48] ${
              audioEnabled
                ? 'bg-[#182030] text-white border border-white/15 hover:bg-[#212B3F]'
                : 'bg-[#E11D48] text-white hover:bg-[#BE123C]'
            }`}
          >
            {audioEnabled ? (
              <>
                <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Mute Broadcast</span>
              </>
            ) : (
              <>
                <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Enable Audio</span>
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
