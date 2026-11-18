import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/usePWAInstall';

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-[#14110A]/95 px-3.5 py-2 text-xs font-medium text-amber-200 shadow-lg backdrop-blur-md"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-400 shrink-0" aria-hidden="true" />
      <span>Offline Mode — Cached broadcast interface active. Live feed resumes on reconnect.</span>
    </div>
  );
}
