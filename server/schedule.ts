import type { ChannelCategory, HostId, ScheduleSlot } from '../shared/broadcastTypes.js';

export interface HourBlockTemplate {
  channel: ChannelCategory;
  hostId: HostId;
  coHostId?: HostId;
  showTitle: string;
  theme: string;
}

export const HOUR_ROTATION: HourBlockTemplate[] = [
  {
    channel: 'news',
    hostId: 'elena',
    showTitle: 'Global Desk 24',
    theme: 'World Headlines, Science & Tech Policy',
  },
  {
    channel: 'music',
    hostId: 'marcus',
    showTitle: 'Frequency & Form',
    theme: 'Continuous Generative Synth & Acoustic Study',
  },
  {
    channel: 'culture',
    hostId: 'sora',
    coHostId: 'elena',
    showTitle: 'Signal & Culture',
    theme: 'Dual-Host Roundtable: Media, Cities & Emerging Tech',
  },
  {
    channel: 'news',
    hostId: 'elena',
    showTitle: 'Global Desk 24',
    theme: 'Global Markets, Infrastructure & Climate Brief',
  },
  {
    channel: 'music',
    hostId: 'marcus',
    coHostId: 'sora',
    showTitle: 'Frequency & Form',
    theme: 'Music Trends & Generative Sound Dialogue',
  },
  {
    channel: 'culture',
    hostId: 'sora',
    showTitle: 'Signal & Culture',
    theme: 'Architecture, Cinema & General Knowledge Dispatch',
  },
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function getSlotForTimestamp(nowMs: number): HourBlockTemplate {
  const utcHour = new Date(nowMs).getUTCHours();
  return HOUR_ROTATION[utcHour % HOUR_ROTATION.length];
}

export function buildDailySchedule(nowMs: number): ScheduleSlot[] {
  const currentUtcHour = new Date(nowMs).getUTCHours();
  const slots: ScheduleSlot[] = [];

  for (let i = 0; i < 12; i++) {
    const utcHour = (currentUtcHour + i) % 24;
    const nextHour = (utcHour + 1) % 24;
    const tpl = HOUR_ROTATION[utcHour % HOUR_ROTATION.length];
    slots.push({
      id: `slot-utc-${utcHour}`,
      utcHour,
      startLabelUtc: `${pad2(utcHour)}:00`,
      endLabelUtc: `${pad2(nextHour)}:00`,
      channel: tpl.channel,
      hostId: tpl.hostId,
      coHostId: tpl.coHostId,
      showTitle: tpl.showTitle,
      theme: tpl.theme,
      isCurrent: i === 0,
    });
  }
  return slots;
}
