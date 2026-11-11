import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import { wyckoffRelativeStrengthFacts } from "trading-strategies/research/wyckoff/wyckoff-relative-strength-facts";

/** The application certifies the complete normalized input/result with its content hash. */
export function wyckoffRelativeStrength(
  stock: Snapshot,
  benchmark: Snapshot,
  start: string,
  end: string,
) {
  const content = wyckoffRelativeStrengthFacts(stock, benchmark, start, end);
  return {
    ...content,
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}
