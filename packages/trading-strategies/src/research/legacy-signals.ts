import type { Bar } from "trading-strategy-core/bars";
import { analyzeBreakout } from "./breakout/breakout.js";
import { researchSwingCoreSeries } from "./swing/research-swing-core.js";
import { researchTechnicalMethodSeries } from "./technical/research-technical-methods.js";
import { researchVolumeSeries } from "./volume/research-volume.js";
import { researchWyckoffSeries } from "./wyckoff/research-wyckoff.js";
import { researchCanslimHighSeries } from "./canslim/research-canslim-high.js";

/** Exact preset identities already used by the archived representative methods. */
export const legacySignalStrategies = {
  "research-wyckoff": { presetId: "wy-sos-daily", warmupBars: 140 },
  "research-growth": { presetId: "canslim-high-98", warmupBars: 300 },
  "research-breakout": { presetId: "sw-double-prior20", warmupBars: 140 },
  "research-indicator-confluence": {
    presetId: "sw-confluence",
    warmupBars: 140,
  },
  "research-volume-price": {
    presetId: "vp-up-expanded-confirm",
    warmupBars: 140,
  },
} as const;
export type LegacySignalStrategyId = keyof typeof legacySignalStrategies;
export function isLegacySignalStrategy(
  id: string,
): id is LegacySignalStrategyId {
  return Object.hasOwn(legacySignalStrategies, id);
}
export function legacySignalSeries(
  id: LegacySignalStrategyId,
  bars: readonly Bar[],
) {
  if (id === "research-wyckoff")
    return researchWyckoffSeries("wy-sos-daily", bars);
  if (id === "research-growth")
    return researchCanslimHighSeries("canslim-high-98", bars);
  if (id === "research-breakout")
    return researchSwingCoreSeries(
      "sw-double-prior20",
      bars,
      analyzeBreakout(bars, 0).points,
    );
  if (id === "research-indicator-confluence")
    return researchTechnicalMethodSeries("sw-confluence", bars);
  return researchVolumeSeries("vp-up-expanded-confirm", bars);
}
