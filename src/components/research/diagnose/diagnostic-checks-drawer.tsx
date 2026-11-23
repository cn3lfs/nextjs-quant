"use client";

import { useRef } from "react";
import {
  DIAGNOSE_CHECK_GROUPS,
  type DiagnoseCheck,
} from "~/lib/research/diagnose-contract";
import { Pill } from "../../panels";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../ui/dialog";
import {
  checkMetadata,
  checkStatusCounts,
  checkStatusMeta,
  extractEvidenceFocus,
  groupChecks,
  type DiagnosticFocusTarget,
} from "./format";

const routineIds = Object.keys(DIAGNOSE_CHECK_GROUPS);

function FocusButtons({
  check,
  onFocusEvidence,
}: {
  check: DiagnoseCheck;
  onFocusEvidence?: (target: DiagnosticFocusTarget) => void;
}) {
  if (!onFocusEvidence || check.evidence === undefined) return null;
  const targets = extractEvidenceFocus(check);
  if (!targets.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {targets.map((target, index) => (
        <Button
          key={index}
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onFocusEvidence(target)}
        >
          {target.ledgerDiff
            ? `账本差额 ${target.date} · ${target.ledgerDiff.field}`
            : target.orderId !== undefined
              ? `定位订单 #${target.orderId}`
              : `定位${target.signalDate ? "信号日" : "日期"} ${target.date}`}
        </Button>
      ))}
    </div>
  );
}

/**
 * The fifteen routine checks plus conditional triggers. This drawer describes
 * engineering health; it never certifies research validity.
 */
export function DiagnosticChecksDrawer({
  open,
  onOpenChange,
  checks,
  subtitle,
  onFocusEvidence,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checks: readonly DiagnoseCheck[];
  subtitle?: string;
  onFocusEvidence?: (target: DiagnosticFocusTarget) => void;
}) {
  const pendingFocus = useRef<DiagnosticFocusTarget | null>(null);
  const returned = new Set(checks.map((check) => check.id));
  const routineAndAdditional = [
    ...checks,
    ...routineIds
      .filter((id) => !returned.has(id))
      .map((id): DiagnoseCheck => ({
        id,
        status: "not-evaluated",
        message: "归档未返回此项检查。",
      })),
  ];
  const counts = checkStatusCounts(routineAndAdditional);
  const groups = groupChecks(routineAndAdditional);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          打开 15 项健康检查
        </Button>
      </DialogTrigger>
      <DialogContent
        className="lg:max-w-3xl"
        onCloseAutoFocus={(event) => {
          const target = pendingFocus.current;
          if (!target) return;
          pendingFocus.current = null;
          event.preventDefault();
          onFocusEvidence?.(target);
        }}
      >
        <DialogHeader>
          <DialogTitle>15 项回测健康检查</DialogTitle>
          <DialogDescription>
            {subtitle ?? "按检查 ID 分组，附本次触发的补充检查。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2">
            <p className="text-sm font-medium text-nc-text">工程健康</p>
            <p className="mt-1 text-sub text-nc-text-3">
              检查回测引擎、撮合、费用与账本是否存在 P0 缺陷。
            </p>
          </div>
          <div className="rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2">
            <p className="text-sm font-medium text-nc-text">研究有效性</p>
            <p className="mt-1 text-sub text-nc-text-3">
              策略是否具备样本外盈利证据，需另行研究验证。
            </p>
          </div>
        </div>

        <dl className="flex flex-wrap gap-3 text-sm">
          {(["pass", "warn", "fail", "not-evaluated", "blocked"] as const).map(
            (status) => (
              <div key={status} className="flex items-center gap-1.5">
                <dt>
                  <Pill tone={checkStatusMeta[status].tone}>
                    {checkStatusMeta[status].label}
                  </Pill>
                </dt>
                <dd className="text-nc-text tabular-nums">{counts[status]}</dd>
              </div>
            ),
          )}
        </dl>

        <div className="space-y-4">
          {groups.map((row) => (
            <section key={row.group} className="space-y-2">
              <h3 className="text-sm font-semibold text-nc-text">
                {row.group}
              </h3>
              <ul className="space-y-2">
                {row.checks.map((check) => {
                  const meta = checkMetadata(check.id);
                  return (
                    <li
                      key={check.id}
                      className="rounded-lg border border-nc-border-soft bg-nc-card px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone={checkStatusMeta[check.status].tone}>
                          {checkStatusMeta[check.status].label}
                        </Pill>
                        <span className="text-sm font-medium text-nc-text">
                          {meta?.label ?? check.id}
                        </span>
                        <code className="text-sub text-nc-text-3">
                          {check.id}
                        </code>
                        <Pill tone="neutral">
                          {meta && !meta.engineeringOnly ? "研究相关" : "工程"}
                        </Pill>
                      </div>
                      <p className="mt-1 text-sm text-nc-text-3">
                        {check.message}
                      </p>
                      <FocusButtons
                        check={check}
                        onFocusEvidence={
                          onFocusEvidence &&
                          ((target) => {
                            pendingFocus.current = target;
                            onOpenChange(false);
                          })
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
