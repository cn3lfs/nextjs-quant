import { describe, expect, it } from "vitest";
import { classifyResearchBatchResult } from "../../src/lib/research/workflow/research-batch-labels";

const event = (symbol: string) => ({ symbol, side: "long" });

describe("research batch labels", () => {
  it("distinguishes full-pool exclusion, sparse signals, and refused simulation", () => {
    expect(
      classifyResearchBatchResult(
        {
          events: [],
          exclusions: [
            { symbol: "sh600000", reason: "复权覆盖缺失" },
            { symbol: "sh600001", reason: "复权覆盖缺失" },
          ],
        },
        2,
      ).label,
    ).toBe("全池排除");
    expect(
      classifyResearchBatchResult({ events: [event("sh600000")] }, 2).label,
    ).toBe("真实样本稀少");
    expect(
      classifyResearchBatchResult(
        {
          events: Array.from({ length: 50 }, () => event("sh600000")),
          partitions: [
            {
              simulation: {
                trades: [],
                attempts: [
                  { symbol: "sh600000", reason: "缺少当日交易限制依据" },
                ],
              },
            },
          ],
        },
        2,
      ).reason,
    ).toContain("受影响证券 1 只");
  });

  it("keeps no-trade for a normal pool with no signals", () => {
    expect(
      classifyResearchBatchResult(
        {
          events: [],
          exclusions: [],
          partitions: [{ simulation: { trades: [], attempts: [] } }],
        },
        2,
      ).label,
    ).toBe("无交易");
  });
});
