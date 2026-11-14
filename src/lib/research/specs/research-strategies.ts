import { researchFormulaRuntime } from "../technical/research-formula-runtime";
import {
  chanC4Strategies,
  chanC4Ids,
} from "trading-strategies/research/chan/research-chan-movements";
import {
  wyckoffHourlyStrategies,
  wyckoffHourlyIds,
} from "trading-strategies/research/wyckoff/research-wyckoff-hourly";
import {
  chanNativeStrategies,
  chanNativeIds,
} from "trading-strategies/research/chan/research-chan-native";
import {
  wyckoffVsaStrategies,
  wyckoffVsaIds,
} from "trading-strategies/research/wyckoff/research-wyckoff-vsa";
import {
  wyckoffStrategies,
  wyckoffIds,
} from "trading-strategies/research/wyckoff/research-wyckoff";
import {
  sepaResearchIds,
  sepaResearchStrategies,
} from "trading-strategies/research/canslim/research-sepa-strategies";
import { baseStrategies, baseStrategyIds } from "./research-base-strategies";
import { z } from "zod";
import {
  canslimResearchIds,
  canslimResearchStrategies,
} from "trading-strategies/research/canslim/research-canslim-strategies";
import {
  breakoutRuleIds,
  breakoutRuleStrategies,
} from "trading-strategies/research/technical/research-breakout-rules";
import {
  channelStrategies,
  channelIds,
} from "trading-strategies/research/technical/research-channels";
import {
  continuationStrategies,
  continuationIds,
} from "trading-strategies/research/technical/research-continuation";
import {
  candleStrategies,
  candleStrategyIds,
} from "trading-strategies/research/technical/research-candles";
import {
  volumeSequenceStrategies,
  volumeSequenceIds,
} from "trading-strategies/research/volume/research-volume-sequence";
import {
  volumeFailureStrategies,
  volumeFailureIds,
} from "trading-strategies/research/volume/research-volume-failure";
import {
  volumeStructureStrategies,
  volumeStructureIds,
} from "trading-strategies/research/volume/research-volume-structure";
import {
  volumeStrategies,
  volumeStrategyIds,
} from "trading-strategies/research/volume/research-volume";
import {
  volumeContextStrategies,
  volumeContextIds,
} from "trading-strategies/research/volume/research-volume-context";
import {
  volumeReversalStrategies,
  volumeReversalIds,
} from "trading-strategies/research/volume/research-volume-reversals";
import {
  buildTechnicalStrategies,
  technicalStrategyIds,
} from "trading-strategies/research/technical/research-technical";

// Only executable families belong here. Definitions drive form options and method snapshots.
const technicalStrategies = buildTechnicalStrategies(researchFormulaRuntime);
export const researchStrategyFamilies = [
  {
    file: "packages/trading-strategies/src/research/chan/research-chan-movements.ts",
    strategies: chanC4Strategies,
    ids: chanC4Ids,
  },
  {
    file: "packages/trading-strategies/src/research/wyckoff/research-wyckoff-hourly.ts",
    strategies: wyckoffHourlyStrategies,
    ids: wyckoffHourlyIds,
  },
  {
    file: "packages/trading-strategies/src/research/chan/research-chan-native.ts",
    strategies: chanNativeStrategies,
    ids: chanNativeIds,
  },
  {
    file: "packages/trading-strategies/src/research/wyckoff/research-wyckoff-vsa.ts",
    strategies: wyckoffVsaStrategies,
    ids: wyckoffVsaIds,
  },
  {
    file: "packages/trading-strategies/src/research/wyckoff/research-wyckoff.ts",
    strategies: wyckoffStrategies,
    ids: wyckoffIds,
  },
  {
    file: "packages/trading-strategies/src/research/canslim/research-sepa-strategies.ts",
    strategies: sepaResearchStrategies,
    ids: sepaResearchIds,
  },
  {
    file: "src/lib/research/specs/research-base-strategies.ts",
    strategies: baseStrategies,
    ids: baseStrategyIds,
  },
  {
    file: "packages/trading-strategies/src/research/technical/research-technical.ts",
    strategies: technicalStrategies,
    ids: technicalStrategyIds,
  },
  {
    file: "packages/trading-strategies/src/research/volume/research-volume.ts",
    strategies: volumeStrategies,
    ids: volumeStrategyIds,
  },
  {
    file: "packages/trading-strategies/src/research/volume/research-volume-reversals.ts",
    strategies: volumeReversalStrategies,
    ids: volumeReversalIds,
  },
  {
    file: "packages/trading-strategies/src/research/volume/research-volume-context.ts",
    strategies: volumeContextStrategies,
    ids: volumeContextIds,
  },
  {
    file: "packages/trading-strategies/src/research/volume/research-volume-structure.ts",
    strategies: volumeStructureStrategies,
    ids: volumeStructureIds,
  },
  {
    file: "packages/trading-strategies/src/research/volume/research-volume-failure.ts",
    strategies: volumeFailureStrategies,
    ids: volumeFailureIds,
  },
  {
    file: "packages/trading-strategies/src/research/volume/research-volume-sequence.ts",
    strategies: volumeSequenceStrategies,
    ids: volumeSequenceIds,
  },
  {
    file: "packages/trading-strategies/src/research/technical/research-candles.ts",
    strategies: candleStrategies,
    ids: candleStrategyIds,
  },
  {
    file: "packages/trading-strategies/src/research/technical/research-continuation.ts",
    strategies: continuationStrategies,
    ids: continuationIds,
  },
  {
    file: "packages/trading-strategies/src/research/technical/research-channels.ts",
    strategies: channelStrategies,
    ids: channelIds,
  },
  {
    file: "packages/trading-strategies/src/research/technical/research-breakout-rules.ts",
    strategies: breakoutRuleStrategies,
    ids: breakoutRuleIds,
  },
  {
    file: "packages/trading-strategies/src/research/canslim/research-canslim-strategies.ts",
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
