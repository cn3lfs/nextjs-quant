import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResearchSpec } from "~/lib/research/strategy-research";
import type { ResearchMarketEvidence } from "~/lib/research/factors/research-market-evidence";
import type { ResearchDataset } from "./research-dataset";
import type { runStrategyResearch } from "./research-run";
import type { ResearchMode } from "~/lib/research/workflow/research-governance";
import {
  ResearchAttempts,
  bestEffortAudit,
} from "../research/research-governance";
import { usageConfigHash } from "../research/research-usage";

export const researchEngineVersion = "sample-engine-governance-1";
export function researchEngineIdentity(strategy: ResearchSpec["strategy"]) {
  const worker = createHash("sha256")
    .update(readFileSync(resolve("runtime/research-worker.cjs")))
    .digest("hex");
  const native =
    strategy === "czsc"
      ? createHash("sha256")
          .update(readFileSync(resolve("runtime/czsc/CZSC64.dll")))
          .digest("hex")
      : "unused";
  return `${researchEngineVersion}:${worker}:${native}`;
}
type ResearchFreeze = {
  version: "research-freeze-1";
  id: string;
  taskId: string;
  frozenAt: number;
  spec: ResearchSpec;
  datasetHash: string;
  evidenceHash: string;
  engineVersion: string;
  resultVersion: "strategy-research-result-1";
};

/** U6b: only date windows are excluded; array order and all other fields remain evidence. */
export function researchParamsFingerprint(spec: ResearchSpec) {
  const { start, end, validationStart, ...params } = spec;
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(params)))
    .digest("hex");
}

export type ResearchTask = {
  id: string;
  spec: ResearchSpec;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  phase: string;
  completed: number;
  total: number;
  error: string | null;
  cancelled: boolean;
  ownerPid?: number;
  mode?: ResearchMode;
  attemptId?: string;
  auditIncomplete?: boolean;
  freezeId?: string;
};
export type ResearchResult = Awaited<ReturnType<typeof runStrategyResearch>>;
export class ResearchStore {
  constructor(
    readonly db: Database.Database,
    readonly limitBytes = 1024 * 1024 * 1024,
  ) {}
  read<T>(id: string, kind: string): T | null {
    const row = this.db
      .prepare("SELECT payload FROM records WHERE id=? AND kind=?")
      .get(id, kind) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : null;
  }
  private insert(kind: string, id: string, value: unknown) {
    this.db
      .transaction(() => {
        if (this.read(id, kind)) return;
        const payload = JSON.stringify(value);
        const usage = this.db
          .prepare(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM records WHERE kind IN ('research-task','research-dataset','research-evidence','research-result')",
          )
          .get() as { bytes: number };
        if (usage.bytes + Buffer.byteLength(payload) > this.limitBytes)
          throw new Error("研究记录超过存储上限，请先导出清理");
        this.db
          .prepare("INSERT INTO records VALUES (?,?,?,?)")
          .run(id, kind, payload, Date.now());
      })
      .immediate();
  }
  create(
    spec: ResearchSpec,
    evidence: ResearchMarketEvidence | null,
    mode: ResearchMode = "exploration",
  ) {
    const task: ResearchTask = {
      id: `research-${randomUUID()}`,
      spec,
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: "等待执行",
      completed: 0,
      total: 0,
      error: null,
      cancelled: false,
      mode,
      ownerPid: process.pid,
    };
    this.db
      .transaction(() => {
        this.insert("research-task", task.id, task);
        if (evidence)
          this.insert("research-evidence", `${task.id}:evidence`, evidence);
        const attempt = bestEffortAudit(() =>
          new ResearchAttempts(this.db).begin({
            taskId: task.id,
            kind: "sample-research",
            config: { spec, mode },
            requestedRange: { start: spec.start, end: spec.end },
            symbols: spec.symbols ?? ["*"],
          }),
        );
        task.attemptId = attempt?.id;
        task.auditIncomplete = !attempt;
        this.db
          .prepare("UPDATE records SET payload=? WHERE id=?")
          .run(JSON.stringify(task), task.id);
        // Keep even if the task/results are later deleted. Exploration is conservatively
        // recorded as potential access; no claim that a particular statistic was viewed.
        if (mode === "exploration")
          bestEffortAudit(() =>
            this.auditInsert("research-access", `${task.id}:access`, {
              taskId: task.id,
              at: task.createdAt,
              range: { start: spec.start, end: spec.end },
              kind: "exploration",
            }),
          );
      })
      .immediate();
    return task;
  }
  task(id: string) {
    return this.read<ResearchTask>(id, "research-task");
  }
  tasks() {
    return (
      this.db
        .prepare(
          "SELECT payload FROM records WHERE kind='research-task' ORDER BY updated_at DESC LIMIT 100",
        )
        .all() as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as ResearchTask);
  }
  paramsFrozenAt(spec: ResearchSpec): number | null {
    const fingerprint = researchParamsFingerprint(spec);
    let earliest: number | null = null;
    // Scan task evidence without the UI list's LIMIT 100 or loading every payload at once.
    const rows = this.db
      .prepare("SELECT payload FROM records WHERE kind='research-task'")
      .iterate() as Iterable<{ payload: string }>;
    for (const row of rows) {
      const task = JSON.parse(row.payload) as ResearchTask;
      if (!Number.isFinite(task.createdAt)) continue;
      if (
        researchParamsFingerprint(task.spec) === fingerprint &&
        (earliest === null || task.createdAt < earliest)
      )
        earliest = task.createdAt;
    }
    return earliest;
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        ResearchTask,
        | "status"
        | "phase"
        | "completed"
        | "total"
        | "error"
        | "ownerPid"
        | "auditIncomplete"
      >
    >,
  ) {
    this.db
      .transaction(() => {
        const task = this.task(id);
        if (
          !task ||
          (task.status === "complete" && patch.auditIncomplete === undefined)
        )
          return;
        const next = {
          ...task,
          ...(task.status === "complete"
            ? { auditIncomplete: patch.auditIncomplete }
            : patch),
          updatedAt: Date.now(),
        };
        if (task.cancelled) next.status = "cancelled";
        this.db
          .prepare(
            "UPDATE records SET payload=?,updated_at=? WHERE id=? AND kind='research-task'",
          )
          .run(JSON.stringify(next), next.updatedAt, id);
        if (task.attemptId && patch.status) {
          const state = next.status === "complete" ? "succeeded" : next.status;
          const audited = bestEffortAudit(() =>
            new ResearchAttempts(this.db).update(task.attemptId!, {
              state,
              error: next.error,
              resultId: next.status === "complete" ? `${id}:result` : null,
            }),
          );
          if (!audited)
            this.db
              .prepare(
                "UPDATE records SET payload=json_set(payload,'$.auditIncomplete',json('true')) WHERE id=?",
              )
              .run(id);
        }
      })
      .immediate();
  }
  cancel(id: string) {
    this.db
      .prepare(
        "UPDATE records SET payload=json_set(payload,'$.cancelled',json('true')) WHERE id=? AND kind='research-task' AND json_extract(payload,'$.status') IN ('queued','running')",
      )
      .run(id);
  }
  recover(isAlive: (pid: number) => boolean) {
    this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            "SELECT payload FROM records WHERE kind='research-task' AND json_extract(payload,'$.status') IN ('running','queued')",
          )
          .all() as { payload: string }[];
        for (const row of rows) {
          const task = JSON.parse(row.payload) as ResearchTask;
          if (task.ownerPid && !isAlive(task.ownerPid)) {
            if (task.attemptId)
              bestEffortAudit(() =>
                new ResearchAttempts(this.db).update(task.attemptId!, {
                  state: "interrupted",
                  error: "执行宿主已退出",
                }),
              );
            this.update(task.id, {
              status: "failed",
              phase: "执行进程已退出",
              error: "执行进程已退出，已保存的快照可用于重试",
            });
          }
        }
      })
      .immediate();
  }
  retry(id: string) {
    return this.db
      .transaction(() => {
        const previous = this.task(id);
        if (
          !previous ||
          !["failed", "cancelled", "complete"].includes(previous.status)
        )
          throw new Error("请等待当前研究结束后重试");
        const next = this.create(
          previous.spec,
          this.evidence(id),
          previous.mode,
        );
        const dataset = this.dataset(id);
        if (dataset) this.saveDataset(next.id, dataset);
        if (previous.mode === "final-validation" && previous.freezeId) {
          if (!dataset)
            throw new Error("冻结数据快照缺失，不能重新采集后冒充重试");
          this.db
            .prepare(
              "UPDATE records SET payload=json_set(payload,'$.freezeId',?) WHERE id=?",
            )
            .run(previous.freezeId, next.id);
          this.freeze(next.id);
        }
        return this.task(next.id)!;
      })
      .immediate();
  }
  dataset(id: string) {
    return this.read<ResearchDataset>(`${id}:dataset`, "research-dataset");
  }
  saveDataset(id: string, dataset: ResearchDataset) {
    this.insert("research-dataset", `${id}:dataset`, dataset);
  }
  result(id: string) {
    return this.read<ResearchResult>(`${id}:result`, "research-result");
  }
  finish(id: string, result: ResearchResult) {
    this.db
      .transaction(() => {
        const task = this.task(id);
        if (!task || task.cancelled) throw new Error("研究已取消");
        if (task.status === "failed" || task.status === "cancelled")
          throw new Error("研究已终止，拒绝保存迟到结果");
        if (task.mode === "final-validation") {
          if (!task.freezeId)
            throw new Error("验证必须先冻结输入，再计算与保存结果");
          this.freeze(id);
        }
        this.insert("research-result", `${id}:result`, result);
        this.update(id, { status: "complete", phase: "完成", error: null });
      })
      .immediate();
  }
  evidence(id: string) {
    return this.read<ResearchMarketEvidence>(
      `${id}:evidence`,
      "research-evidence",
    );
  }
  private auditInsert(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, kind, JSON.stringify(value), Date.now());
  }
  freeze(id: string): ResearchFreeze {
    return this.db
      .transaction(() => {
        const task = this.task(id);
        if (!task || task.mode !== "final-validation")
          throw new Error("任务不是最终验证模式");
        const dataset = this.dataset(id);
        if (!dataset) throw new Error("冻结数据快照缺失");
        const input = {
          spec: task.spec,
          datasetHash: usageConfigHash(dataset),
          evidenceHash: usageConfigHash(this.evidence(id)),
          engineVersion: researchEngineIdentity(task.spec.strategy),
          resultVersion: "strategy-research-result-1" as const,
        };
        if (task.freezeId) {
          const existing = this.read<ResearchFreeze>(
            task.freezeId,
            "research-freeze",
          );
          if (
            !existing ||
            usageConfigHash(input) !==
              usageConfigHash({
                spec: existing.spec,
                datasetHash: existing.datasetHash,
                evidenceHash: existing.evidenceHash,
                engineVersion: existing.engineVersion,
                resultVersion: existing.resultVersion,
              })
          )
            throw new Error(
              "冻结输入或引擎版本不一致，不能用新数据/代码重试原验证",
            );
          return existing;
        }
        const freeze: ResearchFreeze = {
          ...input,
          version: "research-freeze-1",
          id: `research-freeze-${randomUUID()}`,
          taskId: id,
          frozenAt: Date.now(),
        };
        this.auditInsert("research-freeze", freeze.id, freeze);
        this.db
          .prepare(
            "UPDATE records SET payload=json_set(payload,'$.freezeId',?) WHERE id=? AND kind='research-task'",
          )
          .run(freeze.id, id);
        return freeze;
      })
      .immediate();
  }
  isResultVisible(id: string) {
    const task = this.task(id);
    if (!task) return false;
    return (
      task.mode !== "final-validation" ||
      Boolean(
        task.freezeId &&
        this.read(`${task.freezeId}:reveal`, "research-reveal"),
      )
    );
  }
  governance(id: string) {
    const task = this.task(id);
    if (!task) return null;
    const freeze = task.freezeId
      ? this.read<ResearchFreeze>(task.freezeId, "research-freeze")
      : null;
    const reveal = task.freezeId
      ? this.read<{ at: number }>(`${task.freezeId}:reveal`, "research-reveal")
      : null;
    const range = { start: task.spec.validationStart, end: task.spec.end };
    const accesses = (
      this.db
        .prepare(
          "SELECT payload FROM records WHERE kind IN ('research-access','research-reveal')",
        )
        .all() as { payload: string }[]
    ).map(
      (row) =>
        JSON.parse(row.payload) as {
          taskId: string;
          range: { start: string; end: string };
        },
    );
    const accessIds = new Set(
      accesses
        .filter(
          (row) =>
            row.taskId !== id &&
            row.range.start <= range.end &&
            row.range.end >= range.start,
        )
        .map((row) => row.taskId),
    );
    const attempts = new ResearchAttempts(this.db).all();
    const attemptByUsage = new Map(
      attempts.filter((row) => row.usageId).map((row) => [row.usageId!, row]),
    );
    for (const attempt of attempts) {
      if (attempt.taskId === id || attempt.kind === "sample-research") continue;
      const usedRange = attempt.actualRange ?? attempt.requestedRange;
      if (
        usedRange &&
        usedRange.start <= range.end &&
        usedRange.end >= range.start
      )
        accessIds.add(attempt.taskId);
    }
    for (const row of this.db
      .prepare("SELECT payload FROM records WHERE kind='research-usage'")
      .all() as { payload: string }[]) {
      const usage = JSON.parse(row.payload) as {
        id: string;
        range: { start: string; end: string };
      };
      const attempt = attemptByUsage.get(usage.id);
      if (attempt?.taskId === id) continue;
      if (attempt?.kind === "sample-research") {
        const other = this.task(attempt.taskId);
        if (
          other?.mode === "final-validation" &&
          !this.isResultVisible(other.id)
        )
          continue;
      }
      if (usage.range.start <= range.end && usage.range.end >= range.start)
        accessIds.add(attempt?.taskId ?? usage.id);
    }
    // Pre-governance tasks lack access records: visible legacy computations may have
    // been inspected. Never retroactively label them as an untouched holdout.
    for (const row of this.db
      .prepare("SELECT payload FROM records WHERE kind='research-task'")
      .all() as { payload: string }[]) {
      const other = JSON.parse(row.payload) as ResearchTask;
      if (
        other.id !== id &&
        other.mode !== "final-validation" &&
        other.spec.start <= range.end &&
        other.spec.end >= range.start
      )
        accessIds.add(other.id);
    }
    return {
      mode: task.mode ?? "exploration",
      freezeId: freeze?.id ?? null,
      frozenAt: freeze?.frozenAt ?? null,
      engineVersion: freeze?.engineVersion ?? null,
      revealedAt: reveal?.at ?? null,
      resultVisible: this.isResultVisible(id),
      possibleContamination: accessIds.size > 0,
      overlappingAccessCount: accessIds.size,
      warning:
        "揭示仅记录应用内访问，不证明策略有效；其他工具与未记账历史不可观测",
    };
  }
  projectTask(task: ResearchTask) {
    return !this.isResultVisible(task.id)
      ? {
          ...task,
          phase:
            task.status === "complete"
              ? "验证完成，等待显式揭示"
              : task.status === "failed"
                ? "验证失败，可检查配置或重试原快照"
                : task.status === "cancelled"
                  ? "验证已取消"
                  : "正在准备或计算最终验证",
          completed: 0,
          total: 0,
          error: task.error
            ? "最终验证未完成；详情将在揭示前保持隐藏，可重试原快照"
            : null,
        }
      : task;
  }
  reveal(id: string) {
    return this.db
      .transaction(() => {
        const task = this.task(id);
        if (
          !task ||
          task.mode !== "final-validation" ||
          task.status !== "complete" ||
          !task.freezeId ||
          !this.result(id)
        )
          throw new Error("仅可揭示已完成且已冻结的最终验证");
        if (this.read(`${task.freezeId}:reveal`, "research-reveal"))
          return this.governance(id);
        const frozen = this.read<ResearchFreeze>(
          task.freezeId,
          "research-freeze",
        );
        if (
          !frozen ||
          frozen.datasetHash !== usageConfigHash(this.dataset(id)) ||
          frozen.evidenceHash !== usageConfigHash(this.evidence(id)) ||
          usageConfigHash(frozen.spec) !== usageConfigHash(task.spec)
        )
          throw new Error("冻结输入不完整或已改变，拒绝揭示");
        this.auditInsert("research-reveal", `${task.freezeId}:reveal`, {
          version: "research-reveal-1",
          taskId: id,
          freezeId: task.freezeId,
          at: Date.now(),
          range: { start: task.spec.start, end: task.spec.end },
        });
        return this.governance(id);
      })
      .immediate();
  }
  remove(id: string) {
    this.db
      .transaction(() => {
        const task = this.task(id);
        if (!task) return;
        if (["queued", "running"].includes(task.status))
          throw new Error("请先取消并等待研究任务结束");
        for (const [key, kind] of [
          [id, "research-task"],
          [`${id}:dataset`, "research-dataset"],
          [`${id}:result`, "research-result"],
          [`${id}:evidence`, "research-evidence"],
        ])
          this.db
            .prepare("DELETE FROM records WHERE id=? AND kind=?")
            .run(key, kind);
      })
      .immediate();
  }
}
