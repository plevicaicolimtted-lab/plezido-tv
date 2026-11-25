import type { HostId } from '../../shared/broadcastTypes';

export function isBrowserSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

function pickVoiceForHost(hostId: HostId): SpeechSynthesisVoice | null {
  if (!isBrowserSpeechSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const pool = english.length > 0 ? english : voices;

  if (hostId === 'marcus') {
    return (
      pool.find((v) => /daniel|david|mark|alex|male|guy|fred|ryan/i.test(v.name)) ??
      pool[pool.length - 1]
    );
  }
  if (hostId === 'elena') {
    return (
      pool.find((v) => /samantha|victoria|karen|zira|aria|jenny|female|serena/i.test(v.name)) ??
      pool[0]
    );
  }
  return (
    pool.find((v) => /google|natural|aria|jenny|samantha|ava|emma/i.test(v.name)) ??
    pool[0]
  );
}

export function stopBrowserVoice(): void {
  if (!isBrowserSpeechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore speech synthesis cancel errors
  }
}

export function speakWithBrowserVoice(options: {
  text: string;
  hostId: HostId;
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
}): boolean {
  if (!isBrowserSpeechSupported()) return false;
  const clean = options.text.trim();
  if (!clean) return false;

  stopBrowserVoice();

  try {
    const utterance = new SpeechSynthesisUtterance(clean);
    const chosenVoice = pickVoiceForHost(options.hostId);
    if (chosenVoice) {
      utterance.voice = chosenVoice;
    }
    utterance.volume = Math.min(1, Math.max(0, options.volume ?? 0.9));
    utterance.rate = options.hostId === 'elena' ? 1.02 : options.hostId === 'marcus' ? 0.96 : 1.04;
    utterance.pitch = options.hostId === 'marcus' ? 0.88 : options.hostId === 'sora' ? 1.08 : 1.0;

    utterance.onstart = () => options.onStart?.();
    utterance.onend = () => options.onEnd?.();
    utterance.onerror = () => options.onEnd?.();

    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    options.onEnd?.();
    return false;
  }
}
