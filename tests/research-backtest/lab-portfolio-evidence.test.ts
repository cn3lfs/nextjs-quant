import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { strategyLabDetail } from "~/server/db/strategy-lab";
import { ResearchPortfolioEvidenceRepository } from "~/server/db/research-portfolio-evidence";
import {
  importLabPortfolioEvidence,
  labPortfolioEvidenceDetail,
  listLabPortfolioEvidence,
} from "~/server/research/lab-portfolio-evidence";
import {
  researchJsonHash,
  type ResearchExecutionIdentity,
} from "~/server/research/research-run";
import type {
  TenPositionCheckpointKey,
  TenPositionCheckpointRow,
} from "~/lib/research/lab-portfolio-evidence";

type CompletedRow = Extract<TenPositionCheckpointRow, { status: "completed" }>;

const key: TenPositionCheckpointKey = {
  market: "crypto",
  strategyId: "source-sw-bear-order",
  window: "development",
  scenario: "base",
};

const registration = {
  version: "theory-study-ten-2" as const,
  account: { maxPositions: 10 as const, targetWeight: 0.1 as const },
  markets: ["crypto" as const],
  windows: [{ label: "development", start: "2020-01-01", end: "2023-12-31" }],
  scenarios: ["base" as const],
  includeBaseline: false,
  candidates: ["source-sw-bear-order"],
};

// Typed with the runner's own identity contract so a change there breaks this
// fixture at compile time instead of silently accepting a stale shape.
const execution: ResearchExecutionIdentity = {
  runner: {
    path: "D:/github/nextjs-quant/scripts/theory-study.ts",
    hash: "1".repeat(64),
  },
  definitions: [
    {
      path: "D:/github/nextjs-quant/src/lib/research/method-pool-bindings.ts",
      hash: "2".repeat(64),
    },
  ],
  artifacts: {
    roots: ["packages/trading-strategies/dist", "src"],
    hash: "3".repeat(64),
  },
  lockfile: { path: "pnpm-lock.yaml", hash: "4".repeat(64) },
};

const v3Registration = {
  version: "theory-study-ten-3" as const,
  strategyBuildHash: "5".repeat(64),
  engineBuildHash: "source-development",
  execution,
  runnerSnapshotPath: "D:/github/nextjs-quant/.test-data/run/runner-1111.ts",
  account: { maxPositions: 10 as const, targetWeight: 0.1 as const },
  markets: ["cn-equity" as const],
  windows: [{ label: "development", start: "2020-01-01", end: "2023-12-31" }],
  scenarios: ["base" as const],
  includeBaseline: false,
  candidates: [
    "entry5-sw-macd-red",
    "source-sw-macd-red",
    "research-breakout",
    "rsi2",
  ],
  inputEvidence: [
    { path: "D:/github/nextjs-quant/source.json", hash: "6".repeat(64) },
  ],
  biasTags: ["fixture"],
};

const v3Key: TenPositionCheckpointKey = {
  market: "cn-equity",
  strategyId: "source-sw-macd-red",
  window: "development",
  scenario: "base",
};

const realV2SampleDirectory = join(
  process.cwd(),
  ".test-data/method-pool-ten/technical-source-cn",
);
const realV2RegistrationName =
  "registration-d0a65815eecf0a1e8343aca9d63c362a7a4ac4d3856d4f248fdc6fb401c37bfc.json";
const realV2CheckpointName =
  "d0a65815eecf0a1e8343aca9d63c362a7a4ac4d3856d4f248fdc6fb401c37bfc-cn-equity-source-sw-macd-negative-development-base.json";
const hasRealV2Sample =
  existsSync(join(realV2SampleDirectory, realV2RegistrationName)) &&
  existsSync(join(realV2SampleDirectory, realV2CheckpointName));

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function registrationFile(value: unknown = registration) {
  const identity = researchJsonHash(value);
  return {
    identity,
    file: {
      name: `registration-${identity}.json`,
      content: JSON.stringify(value, null, 2),
    },
  };
}

function completedRow(checkpointKey = key): CompletedRow {
  return {
    ...checkpointKey,
    status: "completed",
    peakPositions: 2,
    returnToDrawdown: 1.25,
    meanExposure: 0.5,
    netReturn: 0.1,
    maxDrawdown: 0.08,
    buys: 2,
    sells: 1,
    turnoverNotional: 1000,
    rejectionReasons: { 持仓上限: 0 },
    fees: 1.5,
    rejections: 0,
    observations: 100,
    openPositions: 1,
    quality: "rule-check-only",
    fillsHash: "a".repeat(64),
    curveHash: "b".repeat(64),
  };
}

function checkpointFile(
  identity: string,
  checkpointKey: TenPositionCheckpointKey = key,
  row: TenPositionCheckpointRow = completedRow(checkpointKey),
  contentHash = researchJsonHash(row),
) {
  return {
    contentHash,
    file: {
      name: `${identity}-${checkpointKey.market}-${checkpointKey.strategyId}-${checkpointKey.window}-${checkpointKey.scenario}.json`,
      content: JSON.stringify(
        { identity, key: checkpointKey, row, contentHash },
        null,
        2,
      ),
    },
  };
}

it("imports registration and completed checkpoint idempotently without rewriting evidence", () => {
  const db = setup();
  const repo = new ResearchPortfolioEvidenceRepository(db);
  const reg = registrationFile();
  const checkpoint = checkpointFile(reg.identity);
  const first = importLabPortfolioEvidence(
    { files: [reg.file, checkpoint.file] },
    repo,
  );
  expect(first.map((file) => [file.kind, file.status])).toEqual([
    ["registration", "imported"],
    ["checkpoint", "imported"],
  ]);
  const saved = db
    .prepare("SELECT id,updated_at FROM records ORDER BY id")
    .all();
  const second = importLabPortfolioEvidence(
    { files: [reg.file, checkpoint.file] },
    repo,
  );
  expect(second.map((file) => file.status)).toEqual(["unchanged", "unchanged"]);
  expect(
    db.prepare("SELECT id,updated_at FROM records ORDER BY id").all(),
  ).toEqual(saved);
  expect(listLabPortfolioEvidence(repo)).toMatchObject([
    {
      identity: reg.identity,
      expectedCheckpoints: 1,
      checkpoints: { total: 1, completed: 1, blocked: 0, missing: 0 },
      status: "completed",
    },
  ]);
  const reopened = new ResearchPortfolioEvidenceRepository(db);
  expect(listLabPortfolioEvidence(reopened)[0]?.identity).toBe(reg.identity);
  expect(labPortfolioEvidenceDetail(reg.identity, reopened)?.type).toBe(
    "registration",
  );
  expect(labPortfolioEvidenceDetail(reg.identity, repo)).toMatchObject({
    type: "registration",
    identity: reg.identity,
    checkpoints: [{ status: "completed", contentHash: checkpoint.contentHash }],
  });
  expect(
    labPortfolioEvidenceDetail(checkpoint.contentHash, repo),
  ).toMatchObject({
    type: "checkpoint",
    status: "completed",
    row: { netReturn: 0.1 },
    registration: { identity: reg.identity },
  });
});

it("imports v3 registrations with the recorded execution identity and binding roles", () => {
  const db = setup();
  const repo = new ResearchPortfolioEvidenceRepository(db);
  const reg = registrationFile(v3Registration);
  const checkpoint = checkpointFile(reg.identity, v3Key);
  const imported = importLabPortfolioEvidence(
    { files: [reg.file, checkpoint.file] },
    repo,
  );
  expect(imported.map((file) => [file.kind, file.status])).toEqual([
    ["registration", "imported"],
    ["checkpoint", "imported"],
  ]);
  expect(imported[1]).toMatchObject({
    kind: "checkpoint",
    role: "source-exit",
  });
  expect(listLabPortfolioEvidence(repo)).toMatchObject([
    {
      identity: reg.identity,
      version: "theory-study-ten-3",
      expectedCheckpoints: 4,
      status: "partial",
    },
  ]);
  expect(labPortfolioEvidenceDetail(reg.identity, repo)).toMatchObject({
    type: "registration",
    registration: { version: "theory-study-ten-3", execution },
    candidateRoles: [
      {
        strategyId: "entry5-sw-macd-red",
        role: "entry-experiment",
        preset: "sw-macd-red",
      },
      {
        strategyId: "source-sw-macd-red",
        role: "source-exit",
        preset: "sw-macd-red",
      },
      {
        strategyId: "research-breakout",
        role: "proxy",
        preset: "sw-double-prior20",
      },
      { strategyId: "rsi2", role: "unbound", preset: null },
    ],
    checkpoints: [{ role: "source-exit", status: "completed" }],
  });
  expect(
    labPortfolioEvidenceDetail(checkpoint.contentHash, repo),
  ).toMatchObject({
    type: "checkpoint",
    role: "source-exit",
    row: { netReturn: 0.1 },
  });
});

it("rejects v3 registrations whose execution identity is not the recorded structure", () => {
  const db = setup();
  const repo = new ResearchPortfolioEvidenceRepository(db);
  const { execution: _ignored, ...withoutExecution } = v3Registration;
  const invalid = [
    withoutExecution,
    {
      ...v3Registration,
      execution: { ...execution, runner: { ...execution.runner, hash: "x" } },
    },
    {
      ...v3Registration,
      execution: {
        ...execution,
        artifacts: { ...execution.artifacts, roots: [] },
      },
    },
    {
      ...v3Registration,
      execution: { ...execution, lockfile: { path: "pnpm-lock.yaml" } },
    },
    {
      ...v3Registration,
      execution: { ...execution, extra: true },
    },
  ];
  for (const value of invalid) {
    const file = registrationFile(value);
    expect(() =>
      importLabPortfolioEvidence({ files: [file.file] }, repo),
    ).toThrow(/登记结构无效/);
  }
});

it.skipIf(!hasRealV2Sample)(
  "keeps the real v2 registration sample and its checkpoint importable",
  () => {
    const db = setup();
    const repo = new ResearchPortfolioEvidenceRepository(db);
    const registrationContent = readFileSync(
      join(realV2SampleDirectory, realV2RegistrationName),
      "utf8",
    );
    const checkpointContent = readFileSync(
      join(realV2SampleDirectory, realV2CheckpointName),
      "utf8",
    );
    const value = JSON.parse(registrationContent) as { version: string };
    expect(value.version).toBe("theory-study-ten-2");
    const identity = realV2RegistrationName.slice(
      "registration-".length,
      -".json".length,
    );
    expect(
      importLabPortfolioEvidence(
        {
          files: [
            { name: realV2RegistrationName, content: registrationContent },
            { name: realV2CheckpointName, content: checkpointContent },
          ],
        },
        repo,
      ).map((file) => file.status),
    ).toEqual(["imported", "imported"]);
    expect(listLabPortfolioEvidence(repo)).toMatchObject([
      {
        identity,
        version: "theory-study-ten-2",
        expectedCheckpoints: 28,
        checkpoints: { total: 1, completed: 1 },
      },
    ]);
    const detail = labPortfolioEvidenceDetail(identity, repo);
    expect(detail?.type).toBe("registration");
    if (detail === null || detail.type !== "registration")
      throw new Error("real v2 sample did not resolve to a registration");
    expect(detail.candidateRoles).toHaveLength(28);
    expect(
      detail.candidateRoles.find(
        (candidate) => candidate.strategyId === "source-sw-macd-negative",
      ),
    ).toMatchObject({
      strategyId: "source-sw-macd-negative",
      role: "source-exit",
      preset: "sw-macd-negative",
    });
  },
);

it("keeps blocked rows blocked and never counts them as completed", () => {
  const db = setup();
  const repo = new ResearchPortfolioEvidenceRepository(db);
  const reg = registrationFile();
  const blocked: TenPositionCheckpointRow = {
    ...key,
    status: "blocked",
    reason: "No month-end has eligible low-volatility inputs",
  };
  const checkpoint = checkpointFile(reg.identity, key, blocked);
  importLabPortfolioEvidence({ files: [reg.file, checkpoint.file] }, repo);
  expect(listLabPortfolioEvidence(repo)[0]).toMatchObject({
    status: "blocked",
    checkpoints: { total: 1, completed: 0, blocked: 1, missing: 0 },
  });
  expect(
    labPortfolioEvidenceDetail(checkpoint.contentHash, repo),
  ).toMatchObject({
    type: "checkpoint",
    status: "blocked",
    reason: "No month-end has eligible low-volatility inputs",
    row: { status: "blocked" },
  });
});

it("imports a checkpoint after the registration is already stored", () => {
  const db = setup();
  const repo = new ResearchPortfolioEvidenceRepository(db);
  const reg = registrationFile();
  importLabPortfolioEvidence({ files: [reg.file] }, repo);
  const checkpoint = checkpointFile(reg.identity);
  expect(
    importLabPortfolioEvidence({ files: [checkpoint.file] }, repo)[0]?.status,
  ).toBe("imported");
  expect(listLabPortfolioEvidence(repo)[0]?.status).toBe("completed");
});

it("reports missing registered cases separately from imported rows", () => {
  const db = setup();
  const repo = new ResearchPortfolioEvidenceRepository(db);
  const reg = registrationFile({
    ...registration,
    candidates: ["source-sw-bear-order", "source-sw-macd-red"],
  });
  importLabPortfolioEvidence(
    { files: [reg.file, checkpointFile(reg.identity).file] },
    repo,
  );
  expect(listLabPortfolioEvidence(repo)[0]).toMatchObject({
    status: "partial",
    expectedCheckpoints: 2,
    checkpoints: { total: 1, completed: 1, blocked: 0, missing: 1 },
  });
});

it("refuses to replace an already imported scenario with different evidence", () => {
  const db = setup();
  const repo = new ResearchPortfolioEvidenceRepository(db);
  const reg = registrationFile();
  const original = checkpointFile(reg.identity);
  importLabPortfolioEvidence({ files: [reg.file, original.file] }, repo);
  const changed = completedRow();
  changed.netReturn = 0.9;
  const conflict = checkpointFile(reg.identity, key, changed);
  expect(() =>
    importLabPortfolioEvidence({ files: [conflict.file] }, repo),
  ).toThrow(/同一场景已保存不同证据/);
  expect(labPortfolioEvidenceDetail(original.contentHash, repo)).toMatchObject({
    type: "checkpoint",
    row: { netReturn: 0.1 },
  });
});

it("rejects mismatched identity, key, filename, account and content hash", () => {
  const db = setup();
  const repo = new ResearchPortfolioEvidenceRepository(db);
  const reg = registrationFile();
  const checkpoint = checkpointFile(reg.identity);

  expect(() =>
    importLabPortfolioEvidence(
      {
        files: [
          {
            ...reg.file,
            name: `registration-${"0".repeat(64)}.json`,
          },
        ],
      },
      repo,
    ),
  ).toThrow(/文件名哈希与登记身份不一致/);

  expect(() =>
    importLabPortfolioEvidence({ files: [checkpoint.file] }, repo),
  ).toThrow(/缺少登记文件/);

  importLabPortfolioEvidence({ files: [reg.file] }, repo);

  const wrongWindow = { ...key, window: "holdout" };
  expect(() =>
    importLabPortfolioEvidence(
      {
        files: [checkpointFile(reg.identity, wrongWindow).file],
      },
      repo,
    ),
  ).toThrow(/窗口未在登记中声明/);

  const wrongMarketRow = {
    ...completedRow(),
    market: "cn-equity",
  } as unknown as TenPositionCheckpointRow;
  expect(() =>
    importLabPortfolioEvidence(
      { files: [checkpointFile(reg.identity, key, wrongMarketRow).file] },
      repo,
    ),
  ).toThrow(/证据行的 market 与检查点键不一致/);

  expect(() =>
    importLabPortfolioEvidence(
      {
        files: [
          {
            ...checkpoint.file,
            name: `${reg.identity}-crypto-source-sw-bear-order-holdout-base.json`,
          },
        ],
      },
      repo,
    ),
  ).toThrow(/文件名与检查点键不一致/);

  expect(() =>
    importLabPortfolioEvidence(
      {
        files: [
          checkpointFile(reg.identity, key, completedRow(), "c".repeat(64))
            .file,
        ],
      },
      repo,
    ),
  ).toThrow(/内容哈希与证据行不一致/);

  for (const invalid of [
    { ...registration, version: "theory-study-ten-1" },
    {
      ...registration,
      account: { maxPositions: 20, targetWeight: 0.1 },
    },
  ]) {
    const invalidFile = registrationFile(invalid);
    expect(() =>
      importLabPortfolioEvidence({ files: [invalidFile.file] }, repo),
    ).toThrow(/登记结构无效/);
  }
});

it("does not register, promote or enable a strategy that shares the candidate id", () => {
  const db = setup();
  const repo = new AlertRepository(db);
  const strategy = {
    id: "source-sw-bear-order",
    version: 1,
    market: "crypto" as const,
    period: "day" as const,
    universe: { kind: "symbols" as const, symbols: ["BTCUSDT"] },
    entry: { kind: "constant" as const, value: false },
    exit: {},
    sizing: { kind: "weight" as const, weight: 0.1 },
    sleeve: "swing",
  };
  repo.strategies.saveStrategy(strategy);
  const before = strategyLabDetail(strategy.id, strategy.version, repo);
  const reg = registrationFile();
  importLabPortfolioEvidence(
    { files: [reg.file, checkpointFile(reg.identity).file] },
    new ResearchPortfolioEvidenceRepository(db),
  );
  expect(strategyLabDetail(strategy.id, strategy.version, repo)).toEqual(
    before,
  );
  expect(repo.definitions()).toHaveLength(1);
  for (const action of ["promotion", "shadow", "strategy"])
    expect(
      repo.state(`${action}:${strategy.id}:${strategy.version}`),
    ).toBeUndefined();
});

it("fails closed when a stored evidence row no longer matches its content hash", () => {
  const db = setup();
  const repo = new ResearchPortfolioEvidenceRepository(db);
  const reg = registrationFile();
  const checkpoint = checkpointFile(reg.identity);
  importLabPortfolioEvidence({ files: [reg.file, checkpoint.file] }, repo);
  const id = `research-portfolio:checkpoint:${reg.identity}:${researchJsonHash(key)}`;
  const stored = JSON.parse(
    (
      db.prepare("SELECT payload FROM records WHERE id=?").get(id) as {
        payload: string;
      }
    ).payload,
  ) as { row: CompletedRow };
  stored.row.netReturn = 99;
  db.prepare("UPDATE records SET payload=? WHERE id=?").run(
    JSON.stringify(stored),
    id,
  );
  expect(() =>
    labPortfolioEvidenceDetail(checkpoint.contentHash, repo),
  ).toThrow(/内容哈希校验失败/);
});
