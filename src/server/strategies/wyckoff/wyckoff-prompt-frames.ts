import type { Bar } from "~/lib/domain";
import type { wyckoffFrames } from "./wyckoff-frames";
export const wyckoffPromptVersion = "wyckoff-prompt-3";
export const wyckoffBarColumns = [
  "date",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "amount",
] as const;
const rows = (bars: Bar[]) =>
  bars.map((bar) => wyckoffBarColumns.map((column) => bar[column]));
/** Preserve usable bar indices and values; omit only explicitly unusable hourly prices. */
export function wyckoffPromptFrames(frames: ReturnType<typeof wyckoffFrames>) {
  return {
    ...frames,
    promptVersion: wyckoffPromptVersion,
    barColumns: wyckoffBarColumns,
    daily: { ...frames.daily, bars: rows(frames.daily.bars) },
    weekly: { ...frames.weekly, bars: rows(frames.weekly.bars) },
    hourly: {
      ...frames.hourly,
      bars: frames.hourly.noHourly ? [] : rows(frames.hourly.bars),
      archivedBarCount: frames.hourly.bars.length,
      promptOmission: frames.hourly.noHourly
        ? "小时价格不可用于当前研究；原始档案保留，状态及缺口仍完整提供"
        : null,
    },
  };
}
