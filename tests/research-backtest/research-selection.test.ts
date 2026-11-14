import { expect, it } from "vitest";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
const base = {
  strategy: "dual-breakout",
  start: "2025-01-01",
  end: "2025-02-01",
  validationStart: "2025-01-15",
};
it("rejects empty, duplicated and non A-share explicit lists", () => {
  for (const symbols of [[], ["sh600000", "sh600000"], ["sh000001"]])
    expect(researchSpecSchema.safeParse({ ...base, symbols }).success).toBe(
      false,
    );
});
