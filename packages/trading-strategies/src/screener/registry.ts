import { isValidOhlcvBar } from "./helpers.js";
import type { Bar } from "trading-strategy-core/bars";
import type {
  TheoryFamilyScreenerFactory,
  TheoryScreenContext,
  TheoryScreenerFamilyId,
  TheoryScreenerFilter,
  TheoryScreenerMethodSpec,
  PreparedTheoryFamilyScreener,
} from "./types.js";

const families = new Map<TheoryScreenerFamilyId, TheoryFamilyScreenerFactory>();

export function registerTheoryFamilyScreener(
  family: TheoryScreenerFamilyId,
  factory: TheoryFamilyScreenerFactory,
) {
  families.set(family, factory);
}

/** Factories expose static method specs even with an empty history. */
export function listTheoryScreenerSpecs(): TheoryScreenerMethodSpec[] {
  return [...families.values()].flatMap(
    (factory) => factory({ bars: [] }).specs,
  );
}

function meets(value: number | null, minimum: number | undefined) {
  return minimum === undefined || (value !== null && value >= minimum);
}

export function prepareTheoryScreeners(
  context: TheoryScreenContext,
  filter: TheoryScreenerFilter = {},
): PreparedTheoryFamilyScreener {
  const enabled = [...families]
    .filter(([family]) => !filter.families || filter.families.includes(family))
    .map(([, factory]) => factory(context));
  const specs = enabled
    .flatMap((f) => f.specs)
    .filter(
      (spec) =>
        (!filter.methodIds || filter.methodIds.includes(spec.id)) &&
        (!filter.direction ||
          filter.direction === "both" ||
          spec.direction === "both" ||
          spec.direction === filter.direction),
    );
  const ids = new Set(specs.map((s) => s.id));
  return {
    specs,
    at(index) {
      if (!Number.isInteger(index) || index < 0 || index >= context.bars.length)
        return [];
      return enabled
        .flatMap((f) => f.at(index))
        .filter(
          (m) =>
            ids.has(m.methodId) &&
            m.index === index &&
            (!filter.families || filter.families.includes(m.family)) &&
            (!filter.direction ||
              filter.direction === "both" ||
              filter.direction === m.direction) &&
            meets(m.score, filter.minScore) &&
            meets(m.volumeRatio, filter.minVolumeRatio) &&
            meets(m.rewardMultiple, filter.minRewardMultiple),
        )
        .sort(
          (a, b) =>
            b.score - a.score ||
            (b.rewardMultiple ?? -Infinity) - (a.rewardMultiple ?? -Infinity),
        );
    },
  };
}

export function createRuleFromTheoryScreener(
  methodId: string,
  bars: readonly Bar[],
  options: { holdBars?: number } = {},
) {
  const prepared = prepareTheoryScreeners({ bars }, { methodIds: [methodId] });
  const hold = options.holdBars ?? 25;
  return {
    entry(index: number) {
      return prepared.at(index).length > 0;
    },
    exit(
      index: number,
      position: { entry: number; entryIndex: number; signalIndex?: number },
    ) {
      const bar = bars[index];
      if (
        !isValidOhlcvBar(bar) ||
        !(position.entry > 0) ||
        index < position.entryIndex
      )
        return false;
      if (index - position.entryIndex >= hold) return true;
      const signalIndex = position.signalIndex ?? position.entryIndex - 1;
      if (signalIndex > position.entryIndex) return false;
      const match = prepared.at(signalIndex)[0];
      if (!match) return false;
      const long = match.direction === "long";
      return (
        (match.stopPrice !== null &&
          (long
            ? bar.close <= match.stopPrice
            : bar.close >= match.stopPrice)) ||
        (match.targetPrice !== null &&
          (long
            ? bar.close >= match.targetPrice
            : bar.close <= match.targetPrice))
      );
    },
  };
}
