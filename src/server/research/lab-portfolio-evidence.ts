import { z } from "zod";
import {
  labPortfolioEvidenceImportSchema,
  labPortfolioEvidenceMaxBatchBytes,
  labPortfolioEvidenceMaxFileBytes,
  tenPositionCheckpointEnvelopeSchema,
  tenPositionCheckpointKeySchema,
  tenPositionCheckpointRowSchema,
  tenPositionRegistrationSchema,
  type LabPortfolioCandidateRole,
  type LabPortfolioEvidenceImport,
  type TenPositionCheckpointKey,
  type TenPositionCheckpointRow,
  type TenPositionRegistration,
} from "~/lib/research/lab-portfolio-evidence";
import {
  bindingForStrategy,
  methodPoolRoleForStrategy,
} from "~/lib/research/method-pool-bindings";
import {
  ResearchPortfolioEvidenceRepository,
  type ResearchPortfolioCheckpointIndex,
  type ResearchPortfolioCheckpointRecord,
  type ResearchPortfolioRegistrationRecord,
} from "../db/research-portfolio-evidence";
import { researchJsonHash } from "./research-run";

const registrationName = /^registration-([a-f0-9]{64})\.json$/;
const checkpointName = /^([a-f0-9]{64})-(.+)\.json$/;

type PreparedRegistration = {
  kind: "registration";
  name: string;
  byteLength: number;
  identity: string;
  registration: TenPositionRegistration;
};

type PreparedCheckpoint = {
  kind: "checkpoint";
  name: string;
  byteLength: number;
  identity: string;
  key: TenPositionCheckpointKey;
  row: TenPositionCheckpointRow;
  contentHash: string;
};

type PreparedFile = PreparedRegistration | PreparedCheckpoint;

export type LabPortfolioEvidenceImportResult = {
  name: string;
  kind: PreparedFile["kind"];
  status: "imported" | "unchanged";
  identity: string;
  contentHash?: string;
  role?: LabPortfolioCandidateRole;
};

function parseJsonObject(
  content: string,
  name: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`${name} 不是有效 JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}

function firstIssue(error: z.ZodError) {
  const issue = error.issues[0];
  return issue
    ? `${issue.path.length ? issue.path.join(".") + "：" : ""}${issue.message}`
    : "结构无效";
}

function parseRegistration(
  name: string,
  content: string,
  byteLength: number,
): PreparedRegistration {
  const match = registrationName.exec(name);
  if (!match) throw new Error(`${name} 不是 registration-<哈希>.json 文件`);
  const value = parseJsonObject(content, name);
  const parsed = tenPositionRegistrationSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${name} 登记结构无效：${firstIssue(parsed.error)}`);
  const identity = researchJsonHash(value);
  if (identity !== match[1])
    throw new Error(`${name} 文件名哈希与登记身份不一致`);
  return {
    kind: "registration",
    name,
    byteLength,
    identity,
    // Zod passed; keep the original object so unknown fields remain part of
    // the identity instead of being stripped by the parser.
    registration: value as TenPositionRegistration,
  };
}

function parseCheckpoint(
  name: string,
  content: string,
  byteLength: number,
): PreparedCheckpoint {
  const match = checkpointName.exec(name);
  if (!match)
    throw new Error(
      `${name} 不是 <登记哈希>-<市场>-<策略>-<窗口>-<情景>.json 文件`,
    );
  const value = parseJsonObject(content, name);
  const parsed = tenPositionCheckpointEnvelopeSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${name} 检查点信封无效：${firstIssue(parsed.error)}`);
  const raw = value as {
    identity: string;
    key: TenPositionCheckpointKey;
    row: unknown;
    contentHash: string;
  };
  if (raw.identity !== match[1])
    throw new Error(`${name} 文件名中的登记哈希与检查点身份不一致`);
  const key = tenPositionCheckpointKeySchema.parse(raw.key);
  const expectedName = `${raw.identity}-${key.market}-${key.strategyId}-${key.window}-${key.scenario}.json`;
  if (name !== expectedName) throw new Error(`${name} 文件名与检查点键不一致`);
  const row = tenPositionCheckpointRowSchema.safeParse(raw.row);
  if (!row.success)
    throw new Error(`${name} 证据行无效：${firstIssue(row.error)}`);
  for (const field of ["market", "strategyId", "window", "scenario"] as const)
    if ((raw.row as Record<string, unknown>)[field] !== key[field])
      throw new Error(`${name} 证据行的 ${field} 与检查点键不一致`);
  const contentHash = researchJsonHash(raw.row);
  if (contentHash !== raw.contentHash)
    throw new Error(`${name} 内容哈希与证据行不一致`);
  return {
    kind: "checkpoint",
    name,
    byteLength,
    identity: raw.identity,
    key,
    row: raw.row as TenPositionCheckpointRow,
    contentHash,
  };
}

function prepareFile(
  file: { name: string; content: string },
  index: number,
): PreparedFile {
  if (!file.name || file.name.includes("/") || file.name.includes("\\"))
    throw new Error(`第 ${index + 1} 个文件名无效`);
  const byteLength = Buffer.byteLength(file.content, "utf8");
  if (byteLength > labPortfolioEvidenceMaxFileBytes)
    throw new Error(`${file.name} 超过 8 MiB 限制`);
  if (registrationName.test(file.name))
    return parseRegistration(file.name, file.content, byteLength);
  if (checkpointName.test(file.name))
    return parseCheckpoint(file.name, file.content, byteLength);
  throw new Error(
    `${file.name} 不是十持仓登记或检查点文件（需要 registration-<哈希>.json 或 <登记哈希>-…json）`,
  );
}

function prepareFiles(input: LabPortfolioEvidenceImport) {
  const names = new Set<string>();
  let total = 0;
  return input.files.map((file, index) => {
    if (names.has(file.name))
      throw new Error(`同一批次包含重复文件：${file.name}`);
    names.add(file.name);
    const prepared = prepareFile(file, index);
    total += prepared.byteLength;
    if (total > labPortfolioEvidenceMaxBatchBytes)
      throw new Error("本批文件总大小超过 32 MiB 限制");
    return prepared;
  });
}

function registeredCase(
  registration: TenPositionRegistration,
  key: TenPositionCheckpointKey,
  name: string,
) {
  if (!registration.markets.includes(key.market))
    throw new Error(`${name} 的市场未在登记中声明`);
  if (!registration.windows.some((window) => window.label === key.window))
    throw new Error(`${name} 的窗口未在登记中声明`);
  if (!registration.scenarios.includes(key.scenario))
    throw new Error(`${name} 的成本情景未在登记中声明`);
  const candidates = new Set(registration.candidates);
  if (registration.includeBaseline) candidates.add("baseline-hold");
  if (!candidates.has(key.strategyId))
    throw new Error(`${name} 的策略不在登记候选中`);
}

function validateRegistrationRecord(
  record: ResearchPortfolioRegistrationRecord,
) {
  const parsed = tenPositionRegistrationSchema.safeParse(record.registration);
  if (!parsed.success)
    throw new Error("已保存的登记结构损坏，请重新导入原始文件");
  if (researchJsonHash(record.registration) !== record.identity)
    throw new Error("已保存的登记身份校验失败，请重新导入原始文件");
}

function validateCheckpointRecord(record: ResearchPortfolioCheckpointRecord) {
  tenPositionCheckpointKeySchema.parse(record.key);
  const parsed = tenPositionCheckpointRowSchema.safeParse(record.row);
  if (!parsed.success)
    throw new Error("已保存的检查点证据行损坏，请重新导入原始文件");
  for (const field of ["market", "strategyId", "window", "scenario"] as const)
    if ((record.row as Record<string, unknown>)[field] !== record.key[field])
      throw new Error("已保存的检查点键与证据行不一致");
  if (researchJsonHash(record.row) !== record.contentHash)
    throw new Error("已保存的检查点内容哈希校验失败，请重新导入原始文件");
}

/** Explicit import of ten-position registration/checkpoint files. It only
 * persists evidence: no strategy registration, promotion, shadow/live state or
 * trade is created. A `blocked` row stays blocked and is never counted as a
 * completed run. */
export function importLabPortfolioEvidence(
  raw: z.input<typeof labPortfolioEvidenceImportSchema>,
  repo = new ResearchPortfolioEvidenceRepository(),
): LabPortfolioEvidenceImportResult[] {
  const input = labPortfolioEvidenceImportSchema.parse(raw);
  const prepared = prepareFiles(input);
  const batchRegistrations = new Map<string, PreparedRegistration>(
    prepared
      .filter(
        (file): file is PreparedRegistration => file.kind === "registration",
      )
      .map((file) => [file.identity, file] as const),
  );
  for (const file of prepared) {
    if (file.kind !== "checkpoint") continue;
    const registration =
      batchRegistrations.get(file.identity)?.registration ??
      (() => {
        const saved = repo.registration(file.identity);
        if (!saved) return undefined;
        validateRegistrationRecord(saved);
        return saved.registration;
      })();
    if (!registration)
      throw new Error(
        `${file.name} 缺少登记文件：请先导入 registration-${file.identity}.json`,
      );
    registeredCase(registration, file.key, file.name);
  }
  return repo.atomic(() =>
    prepared.map((file): LabPortfolioEvidenceImportResult => {
      if (file.kind === "registration") {
        const record: ResearchPortfolioRegistrationRecord = {
          identity: file.identity,
          registration: file.registration,
          importedAt: Date.now(),
          filename: file.name,
          byteLength: file.byteLength,
        };
        return {
          name: file.name,
          kind: file.kind,
          identity: file.identity,
          status: repo.ensureRegistration(record) ? "imported" : "unchanged",
        };
      }
      const record: ResearchPortfolioCheckpointRecord = {
        identity: file.identity,
        key: file.key,
        row: file.row,
        contentHash: file.contentHash,
        importedAt: Date.now(),
        filename: file.name,
        byteLength: file.byteLength,
      };
      return {
        name: file.name,
        kind: file.kind,
        identity: file.identity,
        contentHash: file.contentHash,
        role: methodPoolRoleForStrategy(file.key.strategyId),
        status: repo.ensureCheckpoint(record) ? "imported" : "unchanged",
      };
    }),
  );
}

/** Candidate roles come from the single preset -> strategy binding table, so
 * an entry experiment, an original exit and a proxy never blur together just
 * because their ids look similar. */
function candidateRolesOf(candidates: readonly string[]): {
  strategyId: string;
  role: LabPortfolioCandidateRole;
  preset: string | null;
  note: string | null;
}[] {
  return candidates.map((strategyId) => {
    const binding = bindingForStrategy(strategyId);
    return {
      strategyId,
      role: methodPoolRoleForStrategy(strategyId),
      preset: binding?.preset ?? null,
      note: binding?.note ?? null,
    };
  });
}

function countsOf(
  expected: number,
  indexes: readonly ResearchPortfolioCheckpointIndex[],
) {
  const completed = indexes.filter((row) => row.status === "completed").length;
  const blocked = indexes.filter((row) => row.status === "blocked").length;
  const total = indexes.length;
  return {
    total,
    completed,
    blocked,
    missing: Math.max(0, expected - total),
  };
}

function evidenceStatus(counts: {
  total: number;
  completed: number;
  blocked: number;
  missing: number;
}) {
  if (counts.total === 0) return "pending" as const;
  if (counts.completed === 0 && counts.blocked > 0 && counts.missing === 0)
    return "blocked" as const;
  if (counts.missing === 0 && counts.completed === counts.total)
    return "completed" as const;
  return "partial" as const;
}

export function listLabPortfolioEvidence(
  repo = new ResearchPortfolioEvidenceRepository(),
) {
  const counts = repo.checkpointCounts();
  return repo
    .registrationSummaries()
    .map((summary) => {
      const own = counts.get(summary.identity) ?? {
        total: 0,
        completed: 0,
        blocked: 0,
      };
      const checkpoints = {
        ...own,
        missing: Math.max(0, summary.expectedCheckpoints - own.total),
      };
      return {
        ...summary,
        checkpoints,
        status: evidenceStatus(checkpoints),
      };
    })
    .sort(
      (a, b) =>
        b.importedAt - a.importedAt || a.identity.localeCompare(b.identity),
    );
}

export function labPortfolioEvidenceDetail(
  hash: string,
  repo = new ResearchPortfolioEvidenceRepository(),
) {
  const registration = repo.registration(hash);
  if (registration) {
    validateRegistrationRecord(registration);
    const indexes = repo
      .checkpointIndexes(registration.identity)
      .sort(
        (a, b) =>
          a.key.market.localeCompare(b.key.market) ||
          a.key.strategyId.localeCompare(b.key.strategyId) ||
          a.key.window.localeCompare(b.key.window) ||
          a.key.scenario.localeCompare(b.key.scenario),
      );
    for (const index of indexes)
      if (
        index.identity !== registration.identity ||
        index.keyHash !== researchJsonHash(index.key) ||
        index.evidenceId !==
          `research-portfolio:checkpoint:${index.identity}:${index.keyHash}`
      )
        throw new Error("已保存的检查点索引损坏，请重新导入原始文件");
    const { registration: value, ...rest } = registration;
    const expected =
      (value.candidates.length + (value.includeBaseline ? 1 : 0)) *
      value.markets.length *
      value.windows.length *
      value.scenarios.length;
    const counts = countsOf(expected, indexes);
    return {
      type: "registration" as const,
      ...rest,
      registration: value,
      candidateRoles: candidateRolesOf(value.candidates),
      expectedCheckpoints: expected,
      checkpoints: indexes.map((index) => ({
        ...index,
        role: methodPoolRoleForStrategy(index.key.strategyId),
      })),
      counts,
      status: evidenceStatus(counts),
    };
  }
  const index = repo.checkpointIndexByHash(hash);
  if (!index) return null;
  const checkpoint = repo.checkpoint(index.identity, index.key);
  if (!checkpoint) throw new Error("检查点索引存在但证据记录缺失，请重新导入");
  validateCheckpointRecord(checkpoint);
  if (
    checkpoint.identity !== index.identity ||
    JSON.stringify(checkpoint.key) !== JSON.stringify(index.key) ||
    checkpoint.contentHash !== index.contentHash ||
    checkpoint.contentHash !== hash ||
    checkpoint.row.status !== index.status
  )
    throw new Error("检查点索引与证据记录不一致，请重新导入");
  return {
    type: "checkpoint" as const,
    ...index,
    role: methodPoolRoleForStrategy(index.key.strategyId),
    row: checkpoint.row,
    registration: repo.registrationSummary(index.identity) ?? null,
  };
}
