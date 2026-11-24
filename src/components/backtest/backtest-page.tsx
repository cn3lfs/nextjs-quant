"use client";
import { Suspense } from "react";
import { StudioWorkspace } from "../research/studio/studio-workspace";

export function BacktestPage() {
  return (
    <Suspense fallback={<p role="status">正在读取研究工作室…</p>}>
      <StudioWorkspace />
    </Suspense>
  );
}
