import { expectTypeOf, it } from "vitest";
import type { BacktestEvidence, StrategyRepresentative } from "../src/index.js";
type Identity = {
  id: string;
  name: string;
  family: "chan";
  methodId: string;
  dataCoverage: "partial";
  description: string;
  notes: string[];
};
it("rejects contradictory evidence states in the public type", () => {
  expectTypeOf<
    Identity & {
      readiness: "implemented-no-backtest";
      evidence: BacktestEvidence;
    }
  >().not.toExtend<StrategyRepresentative>();
  expectTypeOf<
    Identity & { readiness: "observed-complete-batch" }
  >().not.toExtend<StrategyRepresentative>();
  expectTypeOf<
    Identity & {
      readiness: "observed-complete-batch";
      evidence: BacktestEvidence & { readiness: "observed-incomplete-batch" };
    }
  >().not.toExtend<StrategyRepresentative>();
  expectTypeOf<
    Identity & { readiness: "implemented-no-backtest" }
  >().toExtend<StrategyRepresentative>();
});
