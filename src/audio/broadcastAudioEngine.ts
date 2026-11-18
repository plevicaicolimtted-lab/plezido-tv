import type { BroadcastSegment, MusicScore, SynthPreset } from '../../shared/broadcastTypes';

const NOTE_BASE_MIDI: Record<string, number> = {
  C: 48,
  'C#': 49,
  Db: 49,
  D: 50,
  'D#': 51,
  Eb: 51,
  E: 52,
  F: 53,
  'F#': 54,
  Gb: 54,
  G: 55,
  'G#': 56,
  Ab: 56,
  A: 57,
  'A#': 58,
  Bb: 58,
  B: 59,
};

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function parseChordToFrequencies(chord: string): number[] {
  const match = chord.trim().match(/^([A-G][#b]?)(.*)$/);
  if (!match) {
    return [midiToFreq(50), midiToFreq(53), midiToFreq(57), midiToFreq(60)];
  }
  const rootMidi = NOTE_BASE_MIDI[match[1]] ?? 50;
  const quality = match[2].toLowerCase();

  let intervals = [0, 4, 7, 11]; // Maj7 default
  if (quality.includes('m9')) {
    intervals = [0, 3, 7, 10, 14];
  } else if (quality.includes('m7') || quality.startsWith('m')) {
    intervals = [0, 3, 7, 10];
  } else if (quality.includes('maj9')) {
    intervals = [0, 4, 7, 11, 14];
  } else if (quality.includes('7sus4') || quality.includes('sus4')) {
    intervals = [0, 5, 7, 10];
  } else if (quality.includes('6')) {
    intervals = [0, 4, 7, 9];
  } else if (quality.includes('7')) {
    intervals = [0, 4, 7, 10];
  }

  return intervals.map((step) => midiToFreq(rootMidi + step));
}

class BroadcastAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private voiceAnalyser: AnalyserNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;

  private enabled = false;
  private volume = 0.8;
  private currentSegmentId: string | null = null;
  private currentVoiceSource: AudioBufferSourceNode | null = null;
  private isVoicePlaying = false;
  private musicLoopTimer: number | null = null;
  private currentScore: MusicScore | null = null;
  private chordStep = 0;

  private voiceFreqBins = new Uint8Array(32);
  private masterFreqBins = new Uint8Array(32);

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;

      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 64;

      this.voiceGain = this.ctx.createGain();
      this.voiceGain.gain.value = 1.0;

      this.voiceAnalyser = this.ctx.createAnalyser();
      this.voiceAnalyser.fftSize = 64;

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.45;

      this.voiceGain.connect(this.voiceAnalyser);
      this.voiceAnalyser.connect(this.masterGain);

      this.musicGain.connect(this.masterGain);
      this.masterGain.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  public async enable(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    this.enabled = true;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.volume, ctx.currentTime, 0.08);
    }
    if (this.currentScore) {
      this.startMusicLoop(this.currentScore);
    }
  }

  public disable(): void {
    this.enabled = false;
    this.stopVoice();
    this.stopMusicLoop();
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.06);
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setVolume(next: number): void {
    this.volume = Math.min(1, Math.max(0, next));
    if (this.ctx && this.masterGain && this.enabled) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  public async syncSegment(segment: BroadcastSegment, elapsedSec: number): Promise<void> {
    this.currentScore = segment.musicScore;

    if (!this.enabled) {
      this.currentSegmentId = segment.id;
      return;
    }

    const isNewSegment = this.currentSegmentId !== segment.id;
    this.currentSegmentId = segment.id;

    if (isNewSegment) {
      this.startMusicLoop(segment.musicScore);
      await this.playSegmentVoice(segment, Math.max(0, elapsedSec));
    }
  }

  private stopVoice(): void {
    if (this.currentVoiceSource) {
      try {
        this.currentVoiceSource.onended = null;
        this.currentVoiceSource.stop();
        this.currentVoiceSource.disconnect();
      } catch {
        // Ignore already-stopped source
      }
      this.currentVoiceSource = null;
    }
    this.isVoicePlaying = false;
    this.duckMusic(false);
  }

  private duckMusic(voiceActive: boolean): void {
    if (!this.ctx || !this.musicGain || !this.currentScore) return;
    const baseLevel = Math.min(0.65, Math.max(0.25, this.currentScore.intensity * 0.65));
    const target = voiceActive ? baseLevel * 0.28 : baseLevel;
    this.musicGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.25);
  }

  private async playSegmentVoice(segment: BroadcastSegment, offsetSec: number): Promise<void> {
    this.stopVoice();
    if (!segment.hasAudio || !segment.audioUrl || !this.enabled) {
      return;
    }

    const segIdAtRequest = segment.id;
    try {
      const res = await fetch(segment.audioUrl);
      if (!res.ok) return;
      const arrayBuf = await res.arrayBuffer();
      if (!this.enabled || this.currentSegmentId !== segIdAtRequest) return;

      const ctx = this.ensureContext();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      if (!this.enabled || this.currentSegmentId !== segIdAtRequest) return;

      if (offsetSec >= audioBuf.duration - 0.6) {
        // Already past the spoken portion; let generative music carry the tail
        this.duckMusic(false);
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuf;
      if (this.voiceGain) {
        source.connect(this.voiceGain);
      }
      source.onended = () => {
        if (this.currentVoiceSource === source) {
          this.isVoicePlaying = false;
          this.duckMusic(false);
        }
      };

      this.currentVoiceSource = source;
      this.isVoicePlaying = true;
      this.duckMusic(true);
      source.start(0, Math.max(0, offsetSec));
    } catch {
      this.isVoicePlaying = false;
      this.duckMusic(false);
    }
  }

  private stopMusicLoop(): void {
    if (this.musicLoopTimer !== null) {
      window.clearInterval(this.musicLoopTimer);
      this.musicLoopTimer = null;
    }
  }

  private startMusicLoop(score: MusicScore): void {
    this.stopMusicLoop();
    if (!this.enabled) return;

    this.ensureContext();
    this.duckMusic(this.isVoicePlaying);

    const stepMs = Math.max(900, Math.round((60 / Math.max(60, score.bpm)) * 4 * 1000));
    this.triggerChordBar(score);

    this.musicLoopTimer = window.setInterval(() => {
      if (!this.enabled || !this.currentScore) return;
      this.triggerChordBar(this.currentScore);
    }, stepMs);
  }

  private triggerChordBar(score: MusicScore): void {
    if (!this.ctx || !this.musicGain || this.ctx.state !== 'running') return;

    const chords =
      score.chordProgression.length > 0 ? score.chordProgression : ['Dm9', 'BbMaj7', 'Gm7', 'A7sus4'];
    const chordSymbol = chords[this.chordStep % chords.length];
    this.chordStep += 1;

    const freqs = parseChordToFrequencies(chordSymbol);
    const now = this.ctx.currentTime;
    const barDuration = Math.max(1.2, (60 / Math.max(60, score.bpm)) * 4);
    const preset: SynthPreset = score.synthPreset;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(
      preset === 'warm-rhodes' ? 1400 : preset === 'minimal-pulse' ? 1100 : 850,
      now
    );
    filter.Q.value = 1.2;
    filter.connect(this.musicGain);

    // Subtle bass root
    const bassOsc = this.ctx.createOscillator();
    const bassGain = this.ctx.createGain();
    bassOsc.type = preset === 'deep-dub' ? 'sine' : 'triangle';
    bassOsc.frequency.setValueAtTime(freqs[0] * 0.5, now);
    bassGain.gain.setValueAtTime(0.0001, now);
    bassGain.gain.linearRampToValueAtTime(0.24, now + 0.08);
    bassGain.gain.exponentialRampToValueAtTime(0.001, now + barDuration * 0.95);
    bassOsc.connect(bassGain);
    bassGain.connect(filter);
    bassOsc.start(now);
    bassOsc.stop(now + barDuration);

    // Chord voices
    freqs.forEach((freq, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const noteGain = this.ctx.createGain();

      osc.type =
        preset === 'warm-rhodes'
          ? 'sine'
          : preset === 'minimal-pulse'
            ? 'triangle'
            : 'sawtooth';

      // Slight analog detune for lush stereo-like warmth
      osc.frequency.setValueAtTime(freq, now);
      osc.detune.setValueAtTime((idx % 2 === 0 ? 1 : -1) * 4, now);

      const onsetDelay = preset === 'warm-rhodes' ? idx * 0.035 : idx * 0.01;
      const peakGain = preset === 'ambient-pad' ? 0.055 : 0.08;

      noteGain.gain.setValueAtTime(0.0001, now + onsetDelay);
      noteGain.gain.linearRampToValueAtTime(peakGain, now + onsetDelay + (preset === 'ambient-pad' ? 0.45 : 0.06));
      noteGain.gain.exponentialRampToValueAtTime(0.0008, now + barDuration * 0.98);

      osc.connect(noteGain);
      noteGain.connect(filter);
      osc.start(now + onsetDelay);
      osc.stop(now + barDuration);
    });

    // Gentle pulse ticks for minimal-pulse or deep-dub
    if (preset === 'minimal-pulse' || preset === 'deep-dub') {
      const beatSec = barDuration / 4;
      for (let b = 0; b < 4; b++) {
        const t = now + b * beatSec;
        const pulseOsc = this.ctx.createOscillator();
        const pulseGain = this.ctx.createGain();
        pulseOsc.type = 'sine';
        pulseOsc.frequency.setValueAtTime(b === 0 ? 110 : 78, t);
        pulseGain.gain.setValueAtTime(0.0001, t);
        pulseGain.gain.linearRampToValueAtTime(b === 0 ? 0.14 : 0.07, t + 0.01);
        pulseGain.gain.exponentialRampToValueAtTime(0.0008, t + 0.16);
        pulseOsc.connect(pulseGain);
        pulseGain.connect(filter);
        pulseOsc.start(t);
        pulseOsc.stop(t + 0.18);
      }
    }
  }

  public getVoiceLevel(): number {
    if (!this.enabled || !this.voiceAnalyser || !this.isVoicePlaying) return 0;
    this.voiceAnalyser.getByteFrequencyData(this.voiceFreqBins);
    let sum = 0;
    for (let i = 0; i < this.voiceFreqBins.length; i++) {
      sum += this.voiceFreqBins[i];
    }
    return Math.min(1, sum / (this.voiceFreqBins.length * 140));
  }

  public getSpectrumLevels(count = 24): number[] {
    if (!this.enabled || !this.masterAnalyser) {
      return new Array(count).fill(0);
    }
    this.masterAnalyser.getByteFrequencyData(this.masterFreqBins);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const idx = i % this.masterFreqBins.length;
      out.push(this.masterFreqBins[idx] / 255);
    }
    return out;
  }
}

export const broadcastAudioEngine = new BroadcastAudioEngine();
