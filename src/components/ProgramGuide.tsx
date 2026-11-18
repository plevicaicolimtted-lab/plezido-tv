import { Clock } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  ChannelCategory,
  ChannelSelection,
  PermanentHost,
  ScheduleSlot,
} from '../../shared/broadcastTypes';

interface ProgramGuideProps {
  schedule: ScheduleSlot[];
  hosts: PermanentHost[];
  onTuneChannel: (channel: ChannelSelection) => void;
}

type FilterOption = 'all' | ChannelCategory;

function formatUtcToLocalWindow(utcHour: number): string {
  const start = new Date();
  start.setUTCHours(utcHour, 0, 0, 0);
  const end = new Date(start.getTime() + 3600_000);
  const fmt = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${fmt(start)}–${fmt(end)}`;
}

export function ProgramGuide({ schedule, hosts, onTuneChannel }: ProgramGuideProps) {
  const [filter, setFilter] = useState<FilterOption>('all');

  const filteredSlots = useMemo(() => {
    if (filter === 'all') return schedule;
    return schedule.filter((s) => s.channel === filter);
  }, [schedule, filter]);

  const getHostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;

  return (
    <section
      id="program-guide"
      className="mx-auto max-w-[1440px] px-4 sm:px-6 py-10 border-t border-white/[0.08]"
    >
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-xs font-medium text-slate-400">24/7 Synchronized Timetable</p>
          <h2 className="mt-1 font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Live Broadcast Schedule
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-[#0F131C] p-1 border border-white/[0.08]">
          {(
            [
              { id: 'all', label: 'All Blocks' },
              { id: 'news', label: 'News' },
              { id: 'music', label: 'Music' },
              { id: 'culture', label: 'Culture' },
            ] as Array<{ id: FilterOption; label: string }>
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                filter === item.id
                  ? 'bg-white text-[#06080D]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0B0F17]">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.08] bg-[#0F131C] text-xs font-medium text-slate-400">
                <th className="py-3 px-4">UTC Window</th>
                <th className="py-3 px-4">Your Local Time</th>
                <th className="py-3 px-4">Program</th>
                <th className="py-3 px-4">Permanent Host(s)</th>
                <th className="py-3 px-4 hidden md:table-cell">Editorial Focus</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-sm">
              {filteredSlots.map((slot) => {
                const hostLabel = slot.coHostId
                  ? `${getHostName(slot.hostId)} & ${getHostName(slot.coHostId)}`
                  : getHostName(slot.hostId);

                return (
                  <tr
                    key={slot.id}
                    className={`transition-colors ${
                      slot.isCurrent
                        ? 'bg-[#E11D48]/[0.08]'
                        : 'hover:bg-white/[0.02]'
                    }`}
                  >
                    <td className="py-3.5 px-4 font-mono-tabular text-xs text-slate-300 whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        {slot.isCurrent && (
                          <span className="text-[11px] font-semibold text-[#FB7185]">LIVE</span>
                        )}
                        <span>
                          {slot.startLabelUtc}–{slot.endLabelUtc}
                        </span>
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-mono-tabular text-xs text-slate-400 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3 w-3 text-slate-500" aria-hidden="true" />
                        <span>{formatUtcToLocalWindow(slot.utcHour)}</span>
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-medium text-white whitespace-nowrap">
                      {slot.showTitle}
                    </td>
                    <td className="py-3.5 px-4 text-slate-300 whitespace-nowrap">{hostLabel}</td>
                    <td className="py-3.5 px-4 text-xs text-slate-400 hidden md:table-cell">
                      {slot.theme}
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onTuneChannel(slot.channel)}
                        className="text-xs font-medium text-slate-200 hover:text-white underline decoration-white/25 underline-offset-4"
                      >
                        Tune Channel
                      </button>
                    </td>
                  </tr>
                );
              })}

              {filteredSlots.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-sm text-slate-400">
                    No scheduled blocks match this category filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
