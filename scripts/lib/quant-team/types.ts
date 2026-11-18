import { createHash } from "node:crypto";
import { z } from "zod";
import { QuantTeamError } from "./errors";

export const roles = [
  "researcher",
  "data",
  "trader",
  "risk",
  "backtester",
  "reviewer",
] as const;
export type Role = (typeof roles)[number];

export const runtimeStatuses = [
  "queued",
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type RuntimeStatus = (typeof runtimeStatuses)[number];

export const structuredStatuses = [
  "complete",
  "blocked",
  "needs_decision",
] as const;
export type StructuredStatus = (typeof structuredStatuses)[number];

export const attemptStatuses = [
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type AttemptStatus = (typeof attemptStatuses)[number];

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT = 6;
export const MAX_CONCURRENT = 6;
export const MAX_TASKS = 32;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function isSafeIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".") &&
    !reservedWindowsName.test(value)
  );
}

export const safeIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isSafeIdentifier, {
    message:
      "标识符只能包含字母、数字、点、下划线和连字符，不能以点结尾或包含 ..",
  });

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function isSafeRelativeRef(value: string): boolean {
  if (!value || value.length > 512 || hasControlCharacters(value)) return false;
  if (value.startsWith("~")) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]/).some((part) => part === "..");
}

const inputRefSchema = z.string().refine(isSafeRelativeRef, {
  message: "inputRefs 必须是仓库内相对路径，不能是绝对路径或包含 ..",
});

const candidateVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !hasControlCharacters(value), {
    message: "candidateVersion 不能包含控制字符",
  });

const criteriaSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => !hasControlCharacters(value), {
    message: "completionCriteria 不能包含控制字符",
  });

const goalSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_000)
  .refine((value) => !hasControlCharacters(value), {
    message: "goal 不能包含控制字符",
  });

export const timeoutMsSchema = z
  .number()
  .int()
  .min(MIN_TIMEOUT_MS)
  .max(MAX_TIMEOUT_MS);

const taskInputSchema = z
  .object({
    id: safeIdentifierSchema,
    role: z.enum(roles),
    goal: goalSchema,
    candidateVersion: candidateVersionSchema,
    inputRefs: z.array(inputRefSchema).max(64).default([]),
    completionCriteria: z.array(criteriaSchema).min(1).max(32),
    dependsOn: z.array(safeIdentifierSchema).max(32).default([]),
    heavy: z.boolean().optional(),
    timeoutMs: timeoutMsSchema.optional(),
  })
  .strict();

const batchInputSchema = z
  .object({
    runId: safeIdentifierSchema,
    maxConcurrent: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONCURRENT)
      .default(DEFAULT_MAX_CONCURRENT),
    timeoutMs: timeoutMsSchema.default(DEFAULT_TIMEOUT_MS),
    tasks: z.array(taskInputSchema).min(1).max(MAX_TASKS),
  })
  .strict();

export type NormalizedTask = {
  id: string;
  role: Role;
  goal: string;
  candidateVersion: string;
  inputRefs: string[];
  completionCriteria: string[];
  dependsOn: string[];
  heavy: boolean;
  timeoutMs: number;
};

export type BatchPlan = {
  runId: string;
  maxConcurrent: number;
  timeoutMs: number;
  tasks: NormalizedTask[];
};

export type BatchDefinition = BatchPlan & { definitionHash: string };

export const structuredResultSchema = z
  .object({
    status: z.enum(structuredStatuses),
    conclusion: z.string().trim().min(1).max(8_000),
    facts: z.array(z.string().max(4_000)).max(100),
    evidence: z.array(z.string().max(4_000)).max(100),
    blockers: z.array(z.string().max(4_000)).max(100),
    next: z.array(z.string().max(4_000)).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "complete" && value.blockers.length > 0)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockers"],
        message: "status=complete 时 blockers 必须为空；有阻断必须返回 blocked",
      });
  });

export type StructuredResult = z.infer<typeof structuredResultSchema>;

export const structuredResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { enum: [...structuredStatuses] },
    conclusion: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    next: { type: "array", items: { type: "string" } },
  },
  required: ["status", "conclusion", "facts", "evidence", "blockers", "next"],
  allOf: [
    {
      if: {
        properties: { status: { enum: ["complete"] } },
        required: ["status"],
      },
      then: { properties: { blockers: { maxItems: 0 } } },
    },
  ],
} as const;

export type AttemptRecord = {
  attempt: number;
  sessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: AttemptStatus;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  outputExceeded: boolean;
  permissionDenials: string[];
  isError: boolean;
  structuredStatus: StructuredStatus | null;
  result: StructuredResult | null;
  error: { code: string; message: string } | null;
  upstreamFingerprint: string;
  childPid: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  promptPath: string | null;
};

export type TaskRecord = {
  id: string;
  role: Role;
  goal: string;
  candidateVersion: string;
  inputRefs: string[];
  completionCriteria: string[];
  dependsOn: string[];
  heavy: boolean;
  timeoutMs: number;
  status: RuntimeStatus;
  sessionId: string | null;
  attempts: AttemptRecord[];
  structuredStatus: StructuredStatus | null;
  result: StructuredResult | null;
  blockers: string[];
  lastError: string | null;
  upstreamFingerprint: string | null;
  pendingResume: boolean;
  cancelRequested: boolean;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunSummary = {
  total: number;
  queued: number;
  running: number;
  completed: number;
  blocked: number;
  failed: number;
  cancelled: number;
};

export type RunRecord = {
  schemaVersion: 1;
  runId: string;
  definitionHash: string;
  definition: BatchPlan;
  createdAt: string;
  updatedAt: string;
  status: RuntimeStatus;
  cancelRequested: boolean;
  taskOrder: string[];
  tasks: Record<string, TaskRecord>;
  summary: RunSummary;
  lastError: string | null;
};

export type TaskRunRequest = {
  task: TaskRecord;
  prompt: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  sessionId: string;
  resume: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  attemptDir: string;
  onSpawn?: (pid: number) => void;
  upstream: Array<{
    id: string;
    result: StructuredResult;
    sessionId: string | null;
  }>;
};

export type TaskRunner = (request: TaskRunRequest) => Promise<TaskOutcome>;

export type TaskOutcomeKind = "completed" | "blocked" | "failed" | "cancelled";

export type TaskOutcome = {
  kind: TaskOutcomeKind;
  started: boolean;
  sessionId: string | null;
  structuredStatus: StructuredStatus | null;
  result: StructuredResult | null;
  blockers: string[];
  error: { code: string; message: string } | null;
  timedOut: boolean;
  cancelled: boolean;
  outputExceeded: boolean;
  exitCode: number | null;
  permissionDenials: string[];
  isError: boolean;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  promptPath?: string | null;
};

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function canonicalTask(task: NormalizedTask) {
  return {
    id: task.id,
    role: task.role,
    goal: task.goal,
    candidateVersion: task.candidateVersion,
    inputRefs: task.inputRefs,
    completionCriteria: task.completionCriteria,
    dependsOn: [...task.dependsOn].sort(),
    heavy: task.heavy,
    timeoutMs: task.timeoutMs,
  };
}

export function hashDefinition(plan: BatchPlan): string {
  const canonical = {
    runId: plan.runId,
    maxConcurrent: plan.maxConcurrent,
    timeoutMs: plan.timeoutMs,
    tasks: plan.tasks
      .map(canonicalTask)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

export function hashParts(parts: unknown): string {
  return createHash("sha256").update(stableStringify(parts)).digest("hex");
}

function validateDependencyGraph(tasks: NormalizedTask[]): void {
  const byId = new Map<string, NormalizedTask>();
  for (const task of tasks) {
    if (byId.has(task.id))
      throw new QuantTeamError("DUPLICATE_TASK_ID", `任务 id 重复: ${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const dependency of task.dependsOn) {
      if (dependency === task.id)
        throw new QuantTeamError(
          "SELF_DEPENDENCY",
          `任务 ${task.id} 不能依赖自身`,
        );
      if (!byId.has(dependency))
        throw new QuantTeamError(
          "UNKNOWN_DEPENDENCY",
          `任务 ${task.id} 依赖不存在的任务 ${dependency}`,
        );
      if (seen.has(dependency))
        throw new QuantTeamError(
          "DUPLICATE_DEPENDENCY",
          `任务 ${task.id} 重复声明依赖 ${dependency}`,
        );
      seen.add(dependency);
    }
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string) => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id].join(" -> ");
      throw new QuantTeamError("DEPENDENCY_CYCLE", `依赖存在环: ${cycle}`);
    }
    state.set(id, "visiting");
    stack.push(id);
    const task = byId.get(id);
    if (task) for (const dependency of task.dependsOn) visit(dependency);
    stack.pop();
    state.set(id, "done");
  };
  for (const task of tasks) visit(task.id);
}

export function parseBatchDefinition(input: unknown): BatchDefinition {
  const parsed = batchInputSchema.safeParse(input);
  if (!parsed.success)
    throw new QuantTeamError("INVALID_BATCH", formatZodError(parsed.error));
  const tasks: NormalizedTask[] = parsed.data.tasks.map((task) => ({
    id: task.id,
    role: task.role,
    goal: task.goal,
    candidateVersion: task.candidateVersion,
    inputRefs: task.inputRefs,
    completionCriteria: task.completionCriteria,
    dependsOn: task.dependsOn,
    heavy: task.heavy === true || task.role === "backtester",
    timeoutMs: task.timeoutMs ?? parsed.data.timeoutMs,
  }));
  validateDependencyGraph(tasks);
  const plan: BatchPlan = {
    runId: parsed.data.runId,
    maxConcurrent: parsed.data.maxConcurrent,
    timeoutMs: parsed.data.timeoutMs,
    tasks,
  };
  return { ...plan, definitionHash: hashDefinition(plan) };
}

export function summarizeRun(tasks: Record<string, TaskRecord>): RunSummary {
  const summary: RunSummary = {
    total: 0,
    queued: 0,
    running: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of Object.values(tasks)) {
    summary.total += 1;
    summary[task.status] += 1;
  }
  return summary;
}

export function computeRunStatus(
  tasks: Record<string, TaskRecord>,
  runCancelRequested: boolean,
): RuntimeStatus {
  const statuses = Object.values(tasks).map((task) => task.status);
  if (statuses.includes("running")) return "running";
  if (runCancelRequested) return "cancelled";
  if (statuses.includes("queued")) return "queued";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("cancelled")) return "cancelled";
  return "completed";
}

export function createInitialRunRecord(
  definition: BatchDefinition,
  now: string,
): RunRecord {
  const tasks: Record<string, TaskRecord> = {};
  for (const task of definition.tasks) {
    tasks[task.id] = {
      id: task.id,
      role: task.role,
      goal: task.goal,
      candidateVersion: task.candidateVersion,
      inputRefs: task.inputRefs,
      completionCriteria: task.completionCriteria,
      dependsOn: task.dependsOn,
      heavy: task.heavy,
      timeoutMs: task.timeoutMs,
      status: "queued",
      sessionId: null,
      attempts: [],
      structuredStatus: null,
      result: null,
      blockers: [],
      lastError: null,
      upstreamFingerprint: null,
      pendingResume: false,
      cancelRequested: false,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
    };
  }
  return {
    schemaVersion: 1,
    runId: definition.runId,
    definitionHash: definition.definitionHash,
    definition: {
      runId: definition.runId,
      maxConcurrent: definition.maxConcurrent,
      timeoutMs: definition.timeoutMs,
      tasks: definition.tasks,
    },
    createdAt: now,
    updatedAt: now,
    status: "queued",
    cancelRequested: false,
    taskOrder: definition.tasks.map((task) => task.id),
    tasks,
    summary: summarizeRun(tasks),
    lastError: null,
  };
}
