"use client";

import { useState } from "react";
import Link from "next/link";
import { listTheoryScreenerSpecs } from "trading-strategies";
import {
  buildLabDraftFromHandoff,
  isDiagnosticOnlyStrategyKey,
  isScreenerStrategyKey,
  parseScanToLabHandoff,
  SCREENER_STRATEGY_PREFIX,
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
  draftDirty,
  onApply,
  onDiagnose,
}: {
  search: string;
  draftDirty: boolean;
  onApply: (draft: LabHandoffDraft) => void;
  onDiagnose: (prefill: DiagnoseRunPrefill) => void;
}) {
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [lastAppliedKey, setLastAppliedKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const dismiss = (key: string) =>
    setDismissedKeys((current) => new Set(current).add(key));

  const parsed = parseScanToLabHandoff(new URLSearchParams(search));
  if (
    confirmKey &&
    (parsed.kind !== "valid" || parsed.key !== confirmKey || !draftDirty)
  )
    setConfirmKey(null);
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
  const hint = handoff.strategyHint;
  // A theory screener hint is a research-native rule key; show its Chinese
  // family label instead of the raw `screener:<methodId>` token.
  const screenerHint = hint && isScreenerStrategyKey(hint) ? hint : null;
  const screenerLabel = screenerHint
    ? listTheoryScreenerSpecs().find(
        (spec) => `${SCREENER_STRATEGY_PREFIX}${spec.id}` === screenerHint,
      )?.label
    : undefined;
  const draft = buildLabDraftFromHandoff(handoff);
  const returnLink = handoff.returnTo && (
    <Link className="text-sm underline" href={handoff.returnTo}>
      {handoff.handoffSource === "account-review"
        ? "返回月度复盘"
        : handoff.handoffSource === "watchlist"
          ? "返回自选股"
          : handoff.handoffSource === "pool"
            ? "返回股票池"
            : "返回原筛选列表"}
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

  if (handoff.scope === "portfolio-diagnose") {
    const sourceText = {
      formula: "公式选股批量带入",
      pattern: "形态选股批量带入",
      rps: "RPS 榜单批量带入",
      watchlist: "自选股批量带入",
      pool: "股票池批量带入",
      "account-review": "月度复盘",
    }[handoff.handoffSource];
    return (
      <section
        aria-label="扫描候选批量交接预览"
        className="mb-3 space-y-2 rounded-lg border border-nc-accent bg-nc-inset px-3 py-2"
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <Pill tone="accent">组合交接</Pill>
          <span className="text-sm font-medium text-nc-text">
            来自{sourceText}
          </span>
          <span className="text-sm text-nc-text">
            {handoff.symbols.length} 只
          </span>
          {handoff.label && (
            <span className="text-sm text-nc-text-3">{handoff.label}</span>
          )}
          {screenerHint && (
            <span className="text-sm text-nc-text-3">
              {`策略提示 ${screenerLabel ?? screenerHint}`}
            </span>
          )}
          <span className="text-sub text-nc-text-3">
            冻结日期 {handoff.frozenDate ?? "未提供"}
          </span>
        </div>
        <p className="break-all font-mono text-sm text-nc-text">
          {handoff.symbols.join("、")}
        </p>
        <p className="text-sm text-nc-text-3">
          已预填诊断运行表单的组合标的，核对策略和日期后可手动运行。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {screenerHint && (
            <Button
              type="button"
              size="sm"
              onClick={() =>
                onDiagnose({
                  symbols: handoff.symbols,
                  mode: "portfolio",
                  strategyKey: screenerHint,
                  start: draft.start,
                  end: draft.end,
                })
              }
            >
              带入策略诊断表单
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => dismiss(key)}
          >
            忽略此交接提示
          </Button>
          {returnLink}
        </div>
      </section>
    );
  }

  const diagnosticKey = hint && isDiagnosticOnlyStrategyKey(hint) ? hint : null;
  const diagnoseKey = screenerHint ?? diagnosticKey;
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
          {screenerHint
            ? `策略提示 ${screenerLabel ?? screenerHint}（${screenerHint}）`
            : `策略提示 ${handoff.strategyHint ?? draft.strategyKey}`}
        </span>
      </div>
      {screenerHint ? (
        <p className="text-sm text-nc-text-3">
          {`理论战法「${screenerLabel ?? screenerHint}」按日线结构代理规则运行，将预填诊断运行表单的策略键；请核对标的与日期后手动运行。`}
          {!draft.end && " 请在表单中选择诊断日期范围。"}
        </p>
      ) : diagnosticKey ? (
        <p className="text-sm text-nc-text-3">
          原生缠论与 PIT
          策略需要冻结的诊断证据。此操作仅填入成组情景诊断表单，普通回测草稿可继续编辑。
          {!draft.end && " 请在表单中选择诊断日期范围。"}
        </p>
      ) : (
        <p className="text-sub text-nc-text-4">{draft.scopeNote}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {confirmKey === key && (
          <span role="alert">当前对象回测草稿有未保存修改，确认覆盖？</span>
        )}
        <Button
          type="button"
          size="sm"
          onClick={() => {
            if (diagnoseKey)
              onDiagnose({
                symbol: handoff.symbol,
                ...(diagnoseKey === "core-4"
                  ? { bookPreset: "core-4" }
                  : { strategyKey: diagnoseKey }),
                start: draft.start,
                end: draft.end,
              });
            else if (draftDirty && confirmKey !== key) {
              setConfirmKey(key);
              return;
            } else {
              onApply(draft);
              setConfirmKey(null);
            }
            setLastAppliedKey(key);
          }}
        >
          {diagnoseKey
            ? "带入诊断运行表单"
            : confirmKey === key
              ? "确认覆盖草稿"
              : "应用到回测草稿"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            confirmKey === key ? setConfirmKey(null) : dismiss(key)
          }
        >
          {confirmKey === key ? "取消" : "忽略并保留当前草稿"}
        </Button>
        {returnLink}
      </div>
    </section>
  );
}
