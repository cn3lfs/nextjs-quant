"use client";

import { useState } from "react";
import Link from "next/link";
import {
  buildLabDraftFromHandoff,
  isDiagnosticOnlyStrategyKey,
  parseScanToLabHandoff,
} from "~/lib/research/diagnose-contract";
import { Pill } from "../../panels";
import { Button } from "../../ui/button";
import type { DiagnoseRunPrefill } from "./diagnose-workspace-panel";
import { handoffSourceLabels, type LabHandoffDraft } from "./format";

/**
 * Non-destructive `/scan` → `/lab/backtest` handoff preview.
 *
 * The banner never mutates form state on its own: the draft is applied only by
 * the explicit button. Dismissals are tracked per handoff key, so back/forward
 * to another candidate shows that candidate while an edited draft stays intact.
 */
export function ScanHandoffBanner({
  search,
  onApply,
  onDiagnose,
}: {
  search: string;
  onApply: (draft: LabHandoffDraft) => void;
  onDiagnose: (prefill: DiagnoseRunPrefill) => void;
}) {
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [lastAppliedKey, setLastAppliedKey] = useState<string | null>(null);
  const dismiss = (key: string) =>
    setDismissedKeys((current) => new Set(current).add(key));

  const parsed = parseScanToLabHandoff(new URLSearchParams(search));
  if (parsed.kind === "none") return null;

  if (parsed.kind === "invalid") {
    const key = `invalid:${search}`;
    if (dismissedKeys.has(key)) return null;
    return (
      <div
        role="alert"
        className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2 text-sm"
      >
        <Pill tone="warn">扫描交接</Pill>
        <span className="text-nc-warn">{parsed.message}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => dismiss(key)}
        >
          忽略
        </Button>
      </div>
    );
  }

  const { handoff, key } = parsed;
  if (dismissedKeys.has(key)) return null;
  const sourceLabel = handoffSourceLabels[handoff.handoffSource];
  const returnLink = handoff.returnTo && (
    <Link className="text-sm underline" href={handoff.returnTo}>
      返回原筛选列表
    </Link>
  );
  if (lastAppliedKey === key)
    return (
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-1.5 text-sm">
        <span role="status">
          {`已应用来自 ${sourceLabel} 的候选 ${handoff.symbol}`}
        </span>
        {returnLink}
        <Button
          type="button"
          size="sm"
          variant="plain"
          className="ml-auto px-2"
          aria-label="关闭扫描交接回执"
          onClick={() => dismiss(key)}
        >
          ×
        </Button>
      </div>
    );

  const hint = handoff.strategyHint;
  const diagnosticKey = hint && isDiagnosticOnlyStrategyKey(hint) ? hint : null;
  const draft = buildLabDraftFromHandoff(handoff);
  return (
    <section
      aria-label="扫描候选交接预览"
      className="mb-3 space-y-2 rounded-lg border border-nc-accent bg-nc-inset px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <Pill tone="accent">扫描交接</Pill>
        <span className="text-sm font-medium text-nc-text">{sourceLabel}</span>
        <span className="font-mono text-sm text-nc-text">{handoff.symbol}</span>
        {handoff.label && (
          <span className="text-sm text-nc-text-3">{handoff.label}</span>
        )}
        <span className="text-sub text-nc-text-3">
          冻结日期 {handoff.frozenDate ?? "未提供"}
        </span>
        <span className="text-sub text-nc-text-3">
          策略提示 {handoff.strategyHint ?? draft.strategyKey}
        </span>
      </div>
      {diagnosticKey ? (
        <p className="text-sm text-nc-text-3">
          原生缠论与 PIT
          策略需要冻结的诊断证据。此操作仅填入成组情景诊断表单，普通回测草稿可继续编辑。
          {!draft.end && " 请在表单中选择诊断日期范围。"}
        </p>
      ) : (
        <p className="text-sub text-nc-text-4">{draft.scopeNote}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            if (diagnosticKey)
              onDiagnose({
                symbol: handoff.symbol,
                strategyKey: diagnosticKey,
                start: draft.start,
                end: draft.end,
              });
            else onApply(draft);
            setLastAppliedKey(key);
          }}
        >
          {diagnosticKey ? "带入诊断运行表单" : "应用到回测草稿"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => dismiss(key)}
        >
          忽略并保留当前草稿
        </Button>
        {returnLink}
      </div>
    </section>
  );
}
