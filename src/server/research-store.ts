import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ResearchSpec } from "~/lib/strategy-research";
import type { ResearchMarketEvidence } from "~/lib/research-market-evidence";
import type { ResearchDataset } from "./research-dataset";
import type { runStrategyResearch } from "./research-run";

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
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM records WHERE kind LIKE 'research-%'",
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
  create(spec: ResearchSpec, evidence: ResearchMarketEvidence | null) {
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
    };
    this.db
      .transaction(() => {
        this.insert("research-task", task.id, task);
        if (evidence)
          this.insert("research-evidence", `${task.id}:evidence`, evidence);
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
  update(
    id: string,
    patch: Partial<
      Pick<
        ResearchTask,
        "status" | "phase" | "completed" | "total" | "error" | "ownerPid"
      >
    >,
  ) {
    this.db
      .transaction(() => {
        const task = this.task(id);
        if (!task || task.status === "complete") return;
        const next = { ...task, ...patch, updatedAt: Date.now() };
        if (task.cancelled) next.status = "cancelled";
        this.db
          .prepare(
            "UPDATE records SET payload=?,updated_at=? WHERE id=? AND kind='research-task'",
          )
          .run(JSON.stringify(next), next.updatedAt, id);
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
            "SELECT payload FROM records WHERE kind='research-task' AND json_extract(payload,'$.status')='running'",
          )
          .all() as { payload: string }[];
        for (const row of rows) {
          const task = JSON.parse(row.payload) as ResearchTask;
          if (task.ownerPid && !isAlive(task.ownerPid))
            this.update(task.id, {
              status: "failed",
              phase: "执行进程已退出",
              error: "执行进程已退出，已保存的快照可用于重试",
            });
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
        const next = this.create(previous.spec, this.evidence(id));
        const dataset = this.dataset(id);
        if (dataset) this.saveDataset(next.id, dataset);
        return next;
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
