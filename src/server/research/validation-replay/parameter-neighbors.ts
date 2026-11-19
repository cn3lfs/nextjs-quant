import { type ValidationPolicy } from "quant-backtest";
import {
  type ResearchCandidate,
  strategyObjectSchema,
} from "trading-strategies";
import { resolveFactor, type FactorSpec } from "trading-strategy-core/factors";

export function numericNeighbors(
  candidate: ResearchCandidate,
  method: ValidationPolicy["method"] = "legacy",
): ResearchCandidate[] {
  const stop = candidate.strategy.exit.stop;
  const exits = stop
    ? [0.9, 1.1].map((factor) => ({
        ...candidate,
        strategy: {
          ...candidate.strategy,
          id: `${candidate.strategy.id}-neighbor-${Math.round(factor * 100)}`,
          exit: {
            ...candidate.strategy.exit,
            ...(candidate.variant === "atr" && stop.kind === "atr"
              ? { stop: { ...stop, multiple: stop.multiple * factor } }
              : {}),
            ...(candidate.variant === "trailing"
              ? { trailing: candidate.strategy.exit.trailing! * factor }
              : {}),
            ...(candidate.variant === "time" && candidate.strategy.exit.maxBars
              ? {
                  maxBars: Math.max(
                    1,
                    Math.round(candidate.strategy.exit.maxBars * factor),
                  ),
                }
              : {}),
            ...(candidate.variant === "time" &&
            !candidate.strategy.exit.maxBars &&
            stop.kind === "fixed"
              ? { stop: { ...stop, fraction: stop.fraction * factor } }
              : {}),
          },
        },
        boundary: `${candidate.boundary}; predeclared numeric exit neighbor x${factor}`,
      }))
    : [];
  if (method !== "lifecycle-2") return exits;
  const entry = candidate.strategy.entry;
  const entries = [0.9, 1.1].flatMap((factor) => {
    let changed: typeof entry | null = null;
    if (entry.kind === "dual-ma") {
      const fast = Math.max(1, Math.round(entry.fast * factor));
      changed = {
        ...entry,
        fast,
        slow: Math.max(fast + 1, Math.round(entry.slow * factor)),
      };
    } else if (
      entry.kind === "formula" &&
      Object.keys(entry.parameters).length
    ) {
      changed = {
        ...entry,
        parameters: Object.fromEntries(
          Object.entries(entry.parameters).map(([name, value]) => [
            name,
            /^N\d+$/.test(name)
              ? Math.max(1, Math.round(value * factor))
              : value * factor,
          ]),
        ),
      };
    } else if (entry.kind === "historical-low") {
      changed = {
        ...entry,
        config: {
          years: Math.min(
            10,
            Math.max(5, Math.round(entry.config.years * factor)),
          ),
          minimumBars: Math.max(
            1000,
            Math.round(entry.config.minimumBars * factor),
          ),
          recoveryPercentile: Math.min(
            1,
            Math.max(0.4, entry.config.recoveryPercentile * factor),
          ),
        },
      };
    } else if (entry.kind === "screening-metrics") {
      const fast = Math.max(1, Math.round(entry.fast * factor));
      changed = {
        ...entry,
        fast,
        slow: Math.max(fast + 1, Math.round(entry.slow * factor)),
        minChange: entry.minChange * factor,
        maxChange: entry.maxChange * factor,
        minVolumeRatio: entry.minVolumeRatio * factor,
      };
    } else if (entry.kind === "factor") {
      const perturb = (
        spec: FactorSpec,
      ): { id: FactorSpec["id"]; parameters: Record<string, number> } => {
        const resolved = resolveFactor(spec);
        const parameters = Object.fromEntries(
          Object.entries(resolved.spec.parameters).map(([key, value]) => {
            const rule = resolved.definition.parameters[key]!;
            const adjusted = rule.integer
              ? Math.round(value * factor)
              : value * factor;
            return [key, Math.min(rule.max, Math.max(rule.min, adjusted))];
          }),
        );
        if (parameters.fast !== undefined && parameters.slow !== undefined) {
          parameters.fast = Math.min(parameters.fast, parameters.slow - 1);
          const minimum = resolved.definition.parameters.fast!.min;
          if (parameters.fast < minimum) {
            parameters.fast = minimum;
            parameters.slow = Math.max(parameters.slow, minimum + 1);
          }
        }
        if (parameters.skip !== undefined && parameters.period !== undefined) {
          parameters.skip = Math.min(parameters.skip, parameters.period - 1);
          const minimum = resolved.definition.parameters.skip!.min;
          if (parameters.skip < minimum) {
            parameters.skip = minimum;
            parameters.period = Math.max(parameters.period, minimum + 1);
          }
        }
        return { id: spec.id, parameters };
      };
      changed = {
        ...entry,
        strategy: {
          ...entry.strategy,
          entry: {
            ...entry.strategy.entry,
            conditions: entry.strategy.entry.conditions.map((condition) => ({
              ...condition,
              left: perturb(condition.left),
              right:
                "constant" in condition.right
                  ? { constant: condition.right.constant * factor }
                  : { factor: perturb(condition.right.factor) },
            })),
          },
        },
      };
    } else if (entry.kind === "rps")
      changed = { ...entry, minimum: Math.min(100, entry.minimum * factor) };
    if (!changed || JSON.stringify(changed) === JSON.stringify(entry))
      return [];
    const parsed = strategyObjectSchema.safeParse({
      ...candidate.strategy,
      id: `${candidate.strategy.id}-neighbor-entry-${Math.round(factor * 100)}`,
      entry: changed,
    });
    if (!parsed.success)
      throw new Error(
        `Declared entry neighbor violates its rule schema: ${parsed.error.message}`,
      );
    return [
      {
        ...candidate,
        strategy: parsed.data,
        boundary: `${candidate.boundary}; predeclared numeric entry neighbor x${factor}`,
      },
    ];
  });
  return [...exits, ...entries];
}
