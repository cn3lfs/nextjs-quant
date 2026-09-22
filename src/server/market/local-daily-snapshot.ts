import { resolve } from "node:path";
import { readSnapshot } from "../data-sources/tdx/tdx";
import {
  readFullDaySnapshot,
  fullDayRepairsSameDate,
} from "../data-sources/tdx/tdx-full-day-cache";

/** Keep source files read-only. A full-package import can fill missing history
 * or advance a stale local file, without replacing a newer local trading date.
 */
export async function readLocalDailySnapshot(
  root: string,
  symbol: string,
  options: { chartFunds?: boolean } = {},
) {
  let local;
  let failure: unknown;
  try {
    local = await readSnapshot(root, symbol, "day", options);
  } catch (error) {
    failure = error;
  }
  const cached = readFullDaySnapshot(symbol);
  const repair =
    cached &&
    local &&
    cached.bars.at(-1)!.date === local.bars.at(-1)!.date &&
    fullDayRepairsSameDate(symbol);
  if (
    cached &&
    (!local || cached.bars.at(-1)!.date > local.bars.at(-1)!.date || repair)
  )
    return {
      ...cached,
      dataRoot: resolve(root),
      name: local?.name ?? cached.name,
      sourceNote: repair
        ? "已明确选择完整包修复同日期日线"
        : local
          ? "完整包缓存日期晚于本地日线"
          : "本地日线不可用，使用已导入完整包缓存",
    };
  if (local) return local;
  throw failure ?? new Error("本地日线及完整包缓存均不可用");
}
