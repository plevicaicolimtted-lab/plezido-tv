import {
  Download,
  ExternalLink,
  Laptop,
  Monitor,
  Share,
  Smartphone,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { type DevicePlatform, usePWAInstall } from '../hooks/usePWAInstall';

const PLATFORM_TABS: Array<{
  id: DevicePlatform;
  label: string;
  title: string;
  subtitle: string;
  steps: string[];
}> = [
  {
    id: 'iphone',
    label: 'iPhone',
    title: 'Download on iPhone & iPad',
    subtitle: 'Installs directly to your Home Screen as a full-screen PleziDo TV app.',
    steps: [
      'Open PleziDo TV (/watch) directly in Safari on your iPhone or iPad.',
      'Tap the Share button in the Safari toolbar.',
      'Scroll down and tap "Add to Home Screen", then tap Add.',
    ],
  },
  {
    id: 'android',
    label: 'Android',
    title: 'Download on Android',
    subtitle: 'Installs as a standalone broadcast app via Chrome or Edge on Android.',
    steps: [
      'Open PleziDo TV in its own browser tab (if viewing inside a preview frame) and tap "Install App Now".',
      'Or open the Chrome menu (three dots) in the top right corner.',
      'Tap "Install app" or "Add to Home screen" to download.',
    ],
  },
  {
    id: 'windows',
    label: 'Windows',
    title: 'Download on Windows 10 / 11',
    subtitle: 'Pins PleziDo TV to your Start Menu and Taskbar as a desktop TV app.',
    steps: [
      'Open PleziDo TV in its own Edge or Chrome window (click "Open Standalone Tab" below if embedded).',
      'Click "Install App Now" or click the Install icon in the right side of the browser address bar.',
      'Confirm "Install" to launch PleziDo TV in its own desktop window.',
    ],
  },
  {
    id: 'linux',
    label: 'Linux',
    title: 'Download on Linux Desktop',
    subtitle: 'Creates a native desktop launcher entry for GNOME, KDE, and Chromium browsers.',
    steps: [
      'Open PleziDo TV in its own Chromium, Chrome, or Brave browser tab.',
      'Click "Install App Now" or open the browser menu -> Cast, save, and share -> "Install PleziDo TV".',
      'Pin to your dock or launch from your system app launcher.',
    ],
  },
];

interface PWAInstallButtonProps {
  labelOverride?: string;
}

export function PWAInstallButton({ labelOverride }: PWAInstallButtonProps = {}) {
  const { isInstallable, isInstalled, platform, install } = usePWAInstall();
  const [modalOpen, setModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DevicePlatform>(platform);
  const [installing, setInstalling] = useState(false);
  const [inIframe, setInIframe] = useState(false);

  useEffect(() => {
    setActiveTab(platform);
  }, [platform]);

  useEffect(() => {
    try {
      setInIframe(window.self !== window.top);
    } catch {
      setInIframe(true);
    }
  }, []);

  if (isInstalled) {
    return null;
  }

  const handlePrimaryClick = async () => {
    if (isInstallable) {
      setInstalling(true);
      try {
        const outcome = await install();
        if (outcome === 'unavailable') {
          setModalOpen(true);
        }
      } finally {
        setInstalling(false);
      }
      return;
    }
    setModalOpen(true);
  };

  const selectedGuide =
    PLATFORM_TABS.find((t) => t.id === activeTab) ?? PLATFORM_TABS[0];

  const platformBadgeName =
    platform === 'iphone'
      ? 'iPhone'
      : platform === 'android'
        ? 'Android'
        : platform === 'windows'
          ? 'Windows'
          : 'Linux';

  return (
    <>
      <button
        type="button"
        disabled={installing}
        onClick={() => void handlePrimaryClick()}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          {installing
            ? 'Installing…'
            : labelOverride || `Download TV (${platformBadgeName})`}
        </span>
      </button>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-title"
        >
          <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-white/15 bg-[#0D111A] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
              <div>
                <p className="text-xs text-slate-400">Installable Standalone Broadcast App</p>
                <h3
                  id="pwa-install-title"
                  className="mt-0.5 font-display text-lg font-bold text-white"
                >
                  Download PleziDo TV
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close download instructions"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {inIframe && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <span>
                    Browsers only allow one-click app download outside an embedded preview frame.
                  </span>
                  <a
                    href="/watch"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-[#06080D] hover:bg-slate-200 whitespace-nowrap shrink-0"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Open Standalone Tab</span>
                  </a>
                </div>
              )}

              {/* OS Flavor Switcher */}
              <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#070A10] p-1 border border-white/[0.06]">
                {PLATFORM_TABS.map((tab) => {
                  const Icon =
                    tab.id === 'iphone' || tab.id === 'android'
                      ? Smartphone
                      : tab.id === 'windows'
                        ? Monitor
                        : Laptop;
                  const active = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-md py-2 px-2 text-xs font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-white text-[#06080D]'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              <div>
                <h4 className="font-display text-base font-semibold text-white">
                  {selectedGuide.title}
                </h4>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  {selectedGuide.subtitle}
                </p>

                <ol className="mt-4 space-y-2.5 text-sm text-slate-200">
                  {selectedGuide.steps.map((step, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span className="font-mono-tabular text-xs font-semibold text-[#FB7185] mt-0.5 shrink-0">
                        0{i + 1}.
                      </span>
                      <span className="leading-relaxed">
                        {step}
                        {activeTab === 'iphone' && i === 1 && (
                          <Share
                            className="inline-block ml-1.5 h-3.5 w-3.5 text-slate-300"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
                {isInstallable ? (
                  <button
                    type="button"
                    onClick={() => void install().then(() => setModalOpen(false))}
                    className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Install App Now</span>
                  </button>
                ) : (
                  <a
                    href="/watch"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white underline decoration-white/20 underline-offset-4"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Launch Full Viewer App (/watch)</span>
                  </a>
                )}

                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-white/15 bg-[#161C29] px-4 py-2 text-xs font-medium text-white hover:bg-[#1E2638] transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
