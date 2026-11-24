"use client";

import { useState, type ComponentProps } from "react";
import type { Snapshot } from "~/lib/domain";
import { MaBaselinePanel } from "../backtest/ma-baseline-panel";

type MaStudioControls = Omit<ComponentProps<typeof MaBaselinePanel>, "loaded">;

export function BacktestView({
  loaded,
  studio,
}: {
  loaded: Snapshot | null;
  studio?: MaStudioControls;
}) {
  const [resultId, setResultId] = useState<string | null>(null);
  return (
    <MaBaselinePanel
      loaded={loaded}
      {...(studio ?? {
        view: resultId ? "result" : "compose",
        resultId,
        onResult: setResultId,
        onReuse: () => setResultId(null),
      })}
    />
  );
}
