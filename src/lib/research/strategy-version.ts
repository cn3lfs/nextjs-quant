import type { StrategyObjectInput } from "trading-strategies";

/** Strategy definitions currently declare an integer rule revision. The
 * research receipt expresses that revision as a major SemVer release. */
export function researchStrategyVersion(
  strategy: Pick<StrategyObjectInput, "version">,
): `${number}.0.0` {
  return `${strategy.version}.0.0`;
}
