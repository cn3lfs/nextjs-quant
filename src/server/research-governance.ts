import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  researchAttemptSchema,
  researchAttemptsQuerySchema,
  isAttemptTerminal,
  type ResearchAttempt,
} from "~/lib/research-governance";
import type { z } from "zod";
import type { ResearchRange } from "~/lib/research-usage";
import { usageConfigHash } from "./research-usage";

/** Separate from successful candidate counts. Audit writes never fabricate successes. */
export class ResearchAttempts {
  constructor(readonly db: Database.Database) {}
  read(id: string) {
    const row = this.db
      .prepare(
        "SELECT payload FROM records WHERE id=? AND kind='research-attempt'",
      )
      .get(id) as { payload: string } | undefined;
    return row ? researchAttemptSchema.parse(JSON.parse(row.payload)) : null;
  }
  forTask(taskId: string) {
    const row = this.db
      .prepare(
        "SELECT payload FROM records WHERE kind='research-attempt' AND json_extract(payload,'$.taskId')=? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(taskId) as { payload: string } | undefined;
    return row ? researchAttemptSchema.parse(JSON.parse(row.payload)) : null;
  }
  private write(attempt: ResearchAttempt) {
    const parsed = researchAttemptSchema.parse(attempt);
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
      )
      .run(
        parsed.id,
        "research-attempt",
        JSON.stringify(parsed),
        parsed.updatedAt,
      );
    return parsed;
  }
  begin(input: {
    taskId: string;
    kind: ResearchAttempt["kind"];
    config: unknown;
    requestedRange?: ResearchRange | null;
    symbols?: string[];
  }) {
    return this.write({
      version: "research-attempt-1",
      id: `research-attempt-${randomUUID()}`,
      taskId: input.taskId,
      kind: input.kind,
      state: "queued",
      ownerPid: process.pid,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      configHash: usageConfigHash(input.config),
      requestedRange: input.requestedRange ?? null,
      actualRange: null,
      symbols: input.symbols ?? [],
      resultId: null,
      error: null,
      usageId: null,
      auditIncomplete: false,
    });
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        ResearchAttempt,
        | "state"
        | "actualRange"
        | "symbols"
        | "resultId"
        | "error"
        | "usageId"
        | "auditIncomplete"
      >
    >,
  ) {
    return this.db
      .transaction(() => {
        const previous = this.read(id);
        if (!previous) return previous;
        if (
          isAttemptTerminal(previous.state) &&
          (previous.state !== "succeeded" || patch.state !== undefined)
        )
          return previous;
        return this.write({ ...previous, ...patch, updatedAt: Date.now() });
      })
      .immediate();
  }
  recover(isAlive: (pid: number) => boolean) {
    for (const row of this.all())
      if (!isAttemptTerminal(row.state) && !isAlive(row.ownerPid))
        this.update(row.id, { state: "interrupted", error: "执行宿主已退出" });
  }
  all() {
    return (
      this.db
        .prepare(
          "SELECT payload FROM records WHERE kind='research-attempt' ORDER BY updated_at DESC",
        )
        .all() as { payload: string }[]
    ).map((row) => researchAttemptSchema.parse(JSON.parse(row.payload)));
  }
  page(input: z.infer<typeof researchAttemptsQuerySchema>) {
    const query = researchAttemptsQuerySchema.parse(input);
    const where =
      "kind='research-attempt'" +
      (query.kind ? " AND json_extract(payload,'$.kind')=@kind" : "") +
      (query.state ? " AND json_extract(payload,'$.state')=@state" : "");
    const params = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.state ? { state: query.state } : {}),
    };
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM records WHERE ${where}`)
        .get(params) as { total: number }
    ).total;
    const items = (
      this.db
        .prepare(
          `SELECT payload FROM records WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT @limit OFFSET @offset`,
        )
        .all({
          ...params,
          limit: query.pageSize,
          offset: (query.page - 1) * query.pageSize,
        }) as { payload: string }[]
    ).map((row) => researchAttemptSchema.parse(JSON.parse(row.payload)));
    const safeItems = items.map((item) => {
      const row = this.db
        .prepare(
          "SELECT payload FROM records WHERE id=? AND kind='research-task'",
        )
        .get(item.taskId) as { payload: string } | undefined;
      const task = row
        ? (JSON.parse(row.payload) as { mode?: string; freezeId?: string })
        : null;
      if (
        (!task && item.kind === "sample-research") ||
        (task?.mode === "final-validation" &&
          (!task.freezeId ||
            !this.db
              .prepare(
                "SELECT id FROM records WHERE id=? AND kind='research-reveal'",
              )
              .get(`${task.freezeId}:reveal`)))
      )
        return {
          ...item,
          actualRange: null,
          symbols: [],
          error: item.error ? "最终验证未完成；详细诊断未揭示" : null,
        };
      return item;
    });
    return {
      items: safeItems,
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}

export function bestEffortAudit<T>(write: () => T): T | null {
  try {
    return write();
  } catch {
    console.warn("研究运行审计不完整，请检查本地台账");
    return null;
  }
}
