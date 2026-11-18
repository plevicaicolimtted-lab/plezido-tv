export type HostId = 'elena' | 'marcus' | 'sora';

export type ChannelCategory = 'news' | 'music' | 'culture';

export type ChannelSelection = 'auto' | ChannelCategory;

export type CameraAngle = 'wide-studio' | 'anchor-closeup' | 'split-graphics';

export type LightingMood = 'news-crisp' | 'synth-warm' | 'amber-lounge';

export type SynthPreset = 'ambient-pad' | 'warm-rhodes' | 'minimal-pulse' | 'deep-dub';

export type ModerationVerdict = 'cleared' | 'cleared-with-caution' | 'flagged-revised' | 'blocked';

export interface ModerationReport {
  id: string;
  targetType: 'segment' | 'viewer-request';
  targetId: string;
  headlineOrTopic: string;
  verdict: ModerationVerdict;
  factCheckStatus: 'verified' | 'partially-verified' | 'unverified-revised' | 'not-applicable';
  sensitivityCheck: 'clean' | 'sensitive-framed' | 'blocked';
  flags: string[];
  notes: string;
  checkedAtMs: number;
}

export interface PermanentHost {
  id: HostId;
  name: string;
  role: string;
  showTitle: string;
  channel: ChannelCategory;
  personaTone: string;
  personaTraits: string[];
  expertise: string;
  interactionStyle: string;
  voiceName: 'Kore' | 'Fenrir' | 'Zephyr' | 'Puck' | 'Charon';
  voiceStyle: string;
  studioName: string;
  portraitUrl: string;
  studioSceneUrl: string;
  accentHex: string;
  bio: string;
  scheduleSummary: string;
}

export interface DialogueBeat {
  id: string;
  speakerId: HostId;
  speakerName: string;
  text: string;
  sceneAction: string;
  cameraAngle: CameraAngle;
  startOffsetSec: number;
  durationSec: number;
}

export interface SceneCue {
  cameraAngle: CameraAngle;
  lightingMood: LightingMood;
  visualCardTitle: string;
  visualCardStat: string;
  visualCardDetail: string;
  locationLabel: string;
}

export interface MusicScore {
  title: string;
  genre: string;
  bpm: number;
  musicalKey: string;
  mood: string;
  chordProgression: string[];
  synthPreset: SynthPreset;
  intensity: number;
}

export interface GroundingSource {
  title: string;
  url: string;
}

export interface BroadcastSegment {
  id: string;
  channel: ChannelCategory;
  primaryHostId: HostId;
  coHostId?: HostId;
  showTitle: string;
  headline: string;
  subheadline: string;
  summary: string;
  tickerItems: string[];
  sceneCue: SceneCue;
  dialogueBeats: DialogueBeat[];
  musicScore: MusicScore;
  groundingSources: GroundingSource[];
  moderation: ModerationReport;
  startedAtMs: number;
  durationSec: number;
  endsAtMs: number;
  hasAudio: boolean;
  audioUrl: string | null;
  isLiveGrounded: boolean;
  requestedBy?: string;
}

export interface ScheduleSlot {
  id: string;
  utcHour: number;
  startLabelUtc: string;
  endLabelUtc: string;
  channel: ChannelCategory;
  hostId: HostId;
  coHostId?: HostId;
  showTitle: string;
  theme: string;
  isCurrent: boolean;
}

export type RequestStatus = 'queued' | 'producing' | 'on-air' | 'aired' | 'flagged';

export interface ViewerRequest {
  id: string;
  topic: string;
  category: ChannelCategory;
  requesterName: string;
  status: RequestStatus;
  moderationReason?: string;
  submittedAtMs: number;
  segmentId?: string;
}

export interface BroadcastSyncState {
  serverTimeMs: number;
  viewerCount: number;
  activeNetworkSegment: BroadcastSegment;
  channelSegments: Record<ChannelCategory, BroadcastSegment>;
  hosts: PermanentHost[];
  schedule: ScheduleSlot[];
  queue: ViewerRequest[];
  moderationLog: ModerationReport[];
  recentSegments: BroadcastSegment[];
  nextTransitionAtMs: number;
  isProducingNext: boolean;
}
