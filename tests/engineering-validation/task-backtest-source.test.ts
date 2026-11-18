import { expect, it } from "vitest";
import { put } from "../../src/server/db";
import { taskState } from "../../src/server/db/task-history";
import type { Job } from "../../src/lib/domain";

it.each([
  [
    "daily",
    { type: "strategy-center", strategyId: "theory-nr4-close" },
    "/lab?tab=catalog",
  ],
  [
    "portfolio",
    { type: "strategy-center", portfolio: true },
    "/lab?tab=catalog",
  ],
  [
    "object",
    { type: "lab-backtest", strategy: { id: "custom-object" } },
    "/lab/backtest?mode=object",
  ],
  ["baseline", { symbol: "sh600000" }, "/lab/backtest"],
  ["legacy", { type: "backtest" }, "/lab/backtest"],
] as const)(
  "routes %s backtests to their actual configuration surface",
  (id, input, href) => {
    put("job", id, {
      id,
      type: "backtest",
      status: "completed",
      progress: 100,
      createdAt: 1,
      updatedAt: 2,
      input: { ...input, token: "never-return" },
    } satisfies Job);
    const state = taskState(id)!;
    expect(state.sourceLink).toEqual({ href, label: "前往来源页重新配置" });
    expect(state).not.toHaveProperty("input");
    expect(JSON.stringify(state)).not.toContain("never-return");
  },
);
