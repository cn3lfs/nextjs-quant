import {
  wyckoffHourlyStrategies,
  wyckoffHourlyIds,
} from "./research-wyckoff-hourly";
import { chanNativeStrategies, chanNativeIds } from "./research-chan-native";
import { wyckoffVsaStrategies, wyckoffVsaIds } from "./research-wyckoff-vsa";
import { wyckoffStrategies, wyckoffIds } from "./research-wyckoff";
import {
  sepaResearchIds,
  sepaResearchStrategies,
} from "./research-sepa-strategies";
import { baseStrategies, baseStrategyIds } from "./research-base-strategies";
import { z } from "zod";
import {
  canslimResearchIds,
  canslimResearchStrategies,
} from "./research-canslim-strategies";
import {
  breakoutRuleIds,
  breakoutRuleStrategies,
} from "./research-breakout-rules";
import { channelStrategies, channelIds } from "./research-channels";
import {
  continuationStrategies,
  continuationIds,
} from "./research-continuation";
import { candleStrategies, candleStrategyIds } from "./research-candles";
import {
  volumeSequenceStrategies,
  volumeSequenceIds,
} from "./research-volume-sequence";
import {
  volumeFailureStrategies,
  volumeFailureIds,
} from "./research-volume-failure";
import {
  volumeStructureStrategies,
  volumeStructureIds,
} from "./research-volume-structure";
import { volumeStrategies, volumeStrategyIds } from "./research-volume";
import {
  volumeContextStrategies,
  volumeContextIds,
} from "./research-volume-context";
import {
  volumeReversalStrategies,
  volumeReversalIds,
} from "./research-volume-reversals";
import {
  technicalStrategies,
  technicalStrategyIds,
} from "./research-technical";

// Only executable families belong here. Definitions drive form options and method snapshots.
export const researchStrategyFamilies = [
  {
    file: "src/lib/research-wyckoff-hourly.ts",
    strategies: wyckoffHourlyStrategies,
    ids: wyckoffHourlyIds,
  },
  {
    file: "src/lib/research-chan-native.ts",
    strategies: chanNativeStrategies,
    ids: chanNativeIds,
  },
  {
    file: "src/lib/research-wyckoff-vsa.ts",
    strategies: wyckoffVsaStrategies,
    ids: wyckoffVsaIds,
  },
  {
    file: "src/lib/research-wyckoff.ts",
    strategies: wyckoffStrategies,
    ids: wyckoffIds,
  },
  {
    file: "src/lib/research-sepa-strategies.ts",
    strategies: sepaResearchStrategies,
    ids: sepaResearchIds,
  },
  {
    file: "src/lib/research-base-strategies.ts",
    strategies: baseStrategies,
    ids: baseStrategyIds,
  },
  {
    file: "src/lib/research-technical.ts",
    strategies: technicalStrategies,
    ids: technicalStrategyIds,
  },
  {
    file: "src/lib/research-volume.ts",
    strategies: volumeStrategies,
    ids: volumeStrategyIds,
  },
  {
    file: "src/lib/research-volume-reversals.ts",
    strategies: volumeReversalStrategies,
    ids: volumeReversalIds,
  },
  {
    file: "src/lib/research-volume-context.ts",
    strategies: volumeContextStrategies,
    ids: volumeContextIds,
  },
  {
    file: "src/lib/research-volume-structure.ts",
    strategies: volumeStructureStrategies,
    ids: volumeStructureIds,
  },
  {
    file: "src/lib/research-volume-failure.ts",
    strategies: volumeFailureStrategies,
    ids: volumeFailureIds,
  },
  {
    file: "src/lib/research-volume-sequence.ts",
    strategies: volumeSequenceStrategies,
    ids: volumeSequenceIds,
  },
  {
    file: "src/lib/research-candles.ts",
    strategies: candleStrategies,
    ids: candleStrategyIds,
  },
  {
    file: "src/lib/research-continuation.ts",
    strategies: continuationStrategies,
    ids: continuationIds,
  },
  {
    file: "src/lib/research-channels.ts",
    strategies: channelStrategies,
    ids: channelIds,
  },
  {
    file: "src/lib/research-breakout-rules.ts",
    strategies: breakoutRuleStrategies,
    ids: breakoutRuleIds,
  },
  {
    file: "src/lib/research-canslim-strategies.ts",
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
