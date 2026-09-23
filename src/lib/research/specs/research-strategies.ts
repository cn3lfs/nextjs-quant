import { chanC4Strategies, chanC4Ids } from "../methods/chan/research-chan-movements";
import {
  wyckoffHourlyStrategies,
  wyckoffHourlyIds,
} from "../methods/wyckoff/research-wyckoff-hourly";
import { chanNativeStrategies, chanNativeIds } from "../methods/chan/research-chan-native";
import { wyckoffVsaStrategies, wyckoffVsaIds } from "../methods/wyckoff/research-wyckoff-vsa";
import { wyckoffStrategies, wyckoffIds } from "../methods/wyckoff/research-wyckoff";
import {
  sepaResearchIds,
  sepaResearchStrategies,
} from "./research-sepa-strategies";
import { baseStrategies, baseStrategyIds } from "./research-base-strategies";
import { z } from "zod";
import {
  canslimResearchIds,
  canslimResearchStrategies,
} from "../methods/canslim/research-canslim-strategies";
import {
  breakoutRuleIds,
  breakoutRuleStrategies,
} from "../technical/research-breakout-rules";
import { channelStrategies, channelIds } from "../technical/research-channels";
import {
  continuationStrategies,
  continuationIds,
} from "../technical/research-continuation";
import { candleStrategies, candleStrategyIds } from "../technical/research-candles";
import {
  volumeSequenceStrategies,
  volumeSequenceIds,
} from "../methods/volume/research-volume-sequence";
import {
  volumeFailureStrategies,
  volumeFailureIds,
} from "../methods/volume/research-volume-failure";
import {
  volumeStructureStrategies,
  volumeStructureIds,
} from "../methods/volume/research-volume-structure";
import { volumeStrategies, volumeStrategyIds } from "../methods/volume/research-volume";
import {
  volumeContextStrategies,
  volumeContextIds,
} from "../methods/volume/research-volume-context";
import {
  volumeReversalStrategies,
  volumeReversalIds,
} from "../methods/volume/research-volume-reversals";
import {
  technicalStrategies,
  technicalStrategyIds,
} from "../technical/research-technical";

// Only executable families belong here. Definitions drive form options and method snapshots.
export const researchStrategyFamilies = [
  {
    file: "src/lib/research/methods/chan/research-chan-movements.ts",
    strategies: chanC4Strategies,
    ids: chanC4Ids,
  },
  {
    file: "src/lib/research/methods/wyckoff/research-wyckoff-hourly.ts",
    strategies: wyckoffHourlyStrategies,
    ids: wyckoffHourlyIds,
  },
  {
    file: "src/lib/research/methods/chan/research-chan-native.ts",
    strategies: chanNativeStrategies,
    ids: chanNativeIds,
  },
  {
    file: "src/lib/research/methods/wyckoff/research-wyckoff-vsa.ts",
    strategies: wyckoffVsaStrategies,
    ids: wyckoffVsaIds,
  },
  {
    file: "src/lib/research/methods/wyckoff/research-wyckoff.ts",
    strategies: wyckoffStrategies,
    ids: wyckoffIds,
  },
  {
    file: "src/lib/research/specs/research-sepa-strategies.ts",
    strategies: sepaResearchStrategies,
    ids: sepaResearchIds,
  },
  {
    file: "src/lib/research/specs/research-base-strategies.ts",
    strategies: baseStrategies,
    ids: baseStrategyIds,
  },
  {
    file: "src/lib/research/technical/research-technical.ts",
    strategies: technicalStrategies,
    ids: technicalStrategyIds,
  },
  {
    file: "src/lib/research/methods/volume/research-volume.ts",
    strategies: volumeStrategies,
    ids: volumeStrategyIds,
  },
  {
    file: "src/lib/research/methods/volume/research-volume-reversals.ts",
    strategies: volumeReversalStrategies,
    ids: volumeReversalIds,
  },
  {
    file: "src/lib/research/methods/volume/research-volume-context.ts",
    strategies: volumeContextStrategies,
    ids: volumeContextIds,
  },
  {
    file: "src/lib/research/methods/volume/research-volume-structure.ts",
    strategies: volumeStructureStrategies,
    ids: volumeStructureIds,
  },
  {
    file: "src/lib/research/methods/volume/research-volume-failure.ts",
    strategies: volumeFailureStrategies,
    ids: volumeFailureIds,
  },
  {
    file: "src/lib/research/methods/volume/research-volume-sequence.ts",
    strategies: volumeSequenceStrategies,
    ids: volumeSequenceIds,
  },
  {
    file: "src/lib/research/technical/research-candles.ts",
    strategies: candleStrategies,
    ids: candleStrategyIds,
  },
  {
    file: "src/lib/research/technical/research-continuation.ts",
    strategies: continuationStrategies,
    ids: continuationIds,
  },
  {
    file: "src/lib/research/technical/research-channels.ts",
    strategies: channelStrategies,
    ids: channelIds,
  },
  {
    file: "src/lib/research/technical/research-breakout-rules.ts",
    strategies: breakoutRuleStrategies,
    ids: breakoutRuleIds,
  },
  {
    file: "src/lib/research/methods/canslim/research-canslim-strategies.ts",
    strategies: canslimResearchStrategies,
    ids: canslimResearchIds,
  },
] as const;
export type ResearchStrategyId =
  (typeof researchStrategyFamilies)[number]["ids"][number];
export const researchStrategyIds = researchStrategyFamilies.flatMap(
  (family) => [...family.ids],
) as [ResearchStrategyId, ...ResearchStrategyId[]];
export const researchStrategySchema = z.enum(researchStrategyIds);
type ResearchStrategyDefinition = {
  label: string;
  family: string;
  signal: "dual-breakout" | "czsc" | "ma-cross" | "technical";
  version: string;
  description: string;
  sources: readonly string[];
};
export const researchStrategies = Object.fromEntries(
  researchStrategyFamilies.flatMap((family) =>
    Object.entries(family.strategies),
  ),
) as Record<ResearchStrategyId, ResearchStrategyDefinition>;

export const researchRiskSchema = z
  .object({
    fraction: z.number().finite().min(0.001).max(0.1).default(0.01),
    maxWeight: z.number().finite().min(0.01).max(1).default(0.2),
  })
  .strict();

export function researchStrategyLabel(id: ResearchStrategyId) {
  return researchStrategies[id].label;
}
