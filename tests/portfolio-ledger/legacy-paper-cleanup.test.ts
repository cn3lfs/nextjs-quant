import Database from "better-sqlite3";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { registerPaperCandidates } from "~/server/paper/registration";
import type {
  FrozenCandidate,
  PaperAccount,
  PaperState,
} from "~/server/paper/model";
import {
  applyLegacyPaperPurge,
  inspectLegacyPaper,
  legacyCleanupManifestHash,
  parseCleanupArgs,
} from "../../scripts/legacy-paper-cleanup";

const originalDataDir = process.env.QUANT_DATA_DIR;
const directories: string[] = [];

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "legacy-paper-cleanup-"));
  directories.push(directory);
  return directory;
}

function database(directory: string) {
  const dbPath = join(directory, "quant.sqlite");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  migrate(db);
  return { dbPath, db };
}

function insertProtectedRealData(db: Database.Database) {
  const importedAt = 1_700_000_000_000;
  db.prepare("INSERT INTO import_batches VALUES(?,?,?,?,?,?,?)").run(
    "batch-1",
    "broker",
    "csv",
    "file-hash-1",
    "trades.csv",
    importedAt,
    JSON.stringify({ ok: true }),
  );
  db.prepare("INSERT INTO trade_fills VALUES(?,?,?,?,?,?,?)").run(
    "fill-1",
    "broker",
    "sh600000",
    "600000",
    "2026-11-16",
    "batch-1",
    JSON.stringify({ quantity: 100 }),
  );
  db.prepare("INSERT INTO cash_flows VALUES(?,?,?,?,?)").run(
    "cash-1",
    "broker",
    "2026-11-16",
    "batch-1",
    JSON.stringify({ amount: 100 }),
  );
  db.prepare("INSERT INTO trade_ledger VALUES(?,?,?,?)").run(
    "ledger-1",
    "sh600000",
    "2026-11-16",
    JSON.stringify({ quantity: 100 }),
  );
}

function seedLegacyDatabase(db: Database.Database) {
  const repo = new PaperRepository(db);
  const now = Date.parse("2026-11-16T00:01:00Z");
  const registration = registerPaperCandidates(
    repo,
    now,
    {},
    {
      allowLegacyFixtures: true,
    },
  );
  expect(registration.created).toBe(5);
  const ids = repo.ids();
  expect(ids).toHaveLength(5);
  const base = repo.account(ids[0]!)!;
  const legacyCandidate = base.candidates[0]!;
  for (const id of ids) {
    repo.saveState(id, { marker: id } as unknown as PaperState);
    repo.fact(id, "equity", {
      id: "2026-11-16",
      date: "2026-11-16",
      value: { equity: 1 },
    });
  }
  const customCandidate = {
    ...legacyCandidate,
    strategy: { ...legacyCandidate.strategy, id: "custom-manual", version: 1 },
  } as FrozenCandidate;
  const mixed: PaperAccount = {
    ...base,
    id: "paper:mixed-legacy-and-custom",
    candidates: [legacyCandidate, customCandidate],
    mirrorRevision: "mixed",
    revision: 0,
  };
  const custom: PaperAccount = {
    ...base,
    id: "paper:custom-only",
    candidates: [customCandidate],
    mirrorRevision: "custom",
    revision: 0,
  };
  expect(repo.create(mixed)).toBe(true);
  expect(repo.create(custom)).toBe(true);

  insertProtectedRealData(db);

  const releaseId = ids[0]!;
  const retainId = ids[4]!;
  // Unknown remote intent must retain its venue reservation.
  repo.fact(retainId, "mirror", {
    id: "mirror-1",
    date: "2026-11-16",
    value: { phase: "unknown" },
  });
  const record = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
  record.run(
    "paper-mirror-reservation-binance-demo",
    "paper-mirror-reservation",
    JSON.stringify(releaseId),
    now,
  );
  record.run(
    "paper-mirror-reservation-ths-simulation",
    "paper-mirror-reservation",
    JSON.stringify(retainId),
    now,
  );
  record.run(
    "paper-mirror-reservation-kept",
    "paper-mirror-reservation",
    JSON.stringify(custom.id),
    now,
  );
  return { ids, releaseId, retainId, mixedId: mixed.id, customId: custom.id };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env.QUANT_DATA_DIR = originalDataDir;
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // The runtime sqlite connection may still hold the file on Windows.
    }
  }
});

it("executePaperTick no longer auto-creates the five hardcoded r2a-* accounts", async () => {
  const directory = tempDirectory();
  const dbPath = join(directory, "quant.sqlite");
  process.env.QUANT_DATA_DIR = directory;
  vi.resetModules();
  const { executePaperTick } = await import("~/server/paper/service");
  try {
    await expect(
      executePaperTick({
        type: "paper-tick",
        now: Date.parse("2026-11-16T00:01:00Z"),
      }),
    ).resolves.toEqual([]);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT count(*) n FROM paper_accounts").get()).toEqual(
        {
          n: 0,
        },
      );
    } finally {
      db.close();
    }
  } finally {
    const dbModule = await import("~/server/db");
    dbModule.sqlite().close();
  }
});

it("refuses to reseed the retired fixtures without an explicit test opt-in", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const repo = new PaperRepository(db);
    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => registerPaperCandidates(repo, Date.now(), {}, {})).toThrow(
        /已停用/,
      );
      expect(db.prepare("SELECT count(*) n FROM paper_accounts").get()).toEqual(
        { n: 0 },
      );
      expect(
        registerPaperCandidates(
          repo,
          Date.now(),
          {},
          {
            allowLegacyFixtures: true,
          },
        ).created,
      ).toBe(5);
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  } finally {
    db.close();
  }
});

it("dry-run reports only exact legacy accounts and never modifies the database file", () => {
  const directory = tempDirectory();
  const { dbPath, db } = database(directory);
  const seeded = seedLegacyDatabase(db);
  db.close();

  const beforeBytes = readFileSync(dbPath);
  const beforeStat = statSync(dbPath);
  const report = inspectLegacyPaper(dbPath);
  const afterStat = statSync(dbPath);

  expect(report.manifestHash).toBe(legacyCleanupManifestHash(report.manifest));
  expect(report.manifest.database.path).toBe(dbPath);
  expect(report.manifest.accounts.map((a) => a.id)).toEqual(seeded.ids);
  for (const account of report.manifest.accounts) {
    expect(account.accountSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(account.stateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(account.factSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(account.stateRows).toBeGreaterThan(0);
    expect(account.factRows).toBeGreaterThan(0);
  }
  expect(report.manifest.excluded.mixed.map((a) => a.id)).toEqual([
    seeded.mixedId,
  ]);
  expect(report.manifest.excluded.custom.map((a) => a.id)).toEqual([
    seeded.customId,
  ]);
  expect(report.manifest.totals).toEqual({
    accounts: 5,
    stateRows: 5,
    factRows: 6,
  });
  expect(report.manifest.protected).toMatchObject({
    import_batches: { rows: 1 },
    trade_fills: { rows: 1 },
    cash_flows: { rows: 1 },
    trade_ledger: { rows: 1 },
  });
  expect(report.manifest.reservations).toEqual([
    {
      id: "paper-mirror-reservation-binance-demo",
      accountId: seeded.releaseId,
      action: "release",
    },
    {
      id: "paper-mirror-reservation-ths-simulation",
      accountId: seeded.retainId,
      action: "retain",
    },
  ]);

  expect(readFileSync(dbPath).equals(beforeBytes)).toBe(true);
  expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  expect(afterStat.size).toBe(beforeStat.size);
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  expect(existsSync(`${dbPath}-shm`)).toBe(false);
});

it("apply purge rejects a missing, malformed or mismatched manifest hash and leaves no backup", async () => {
  const directory = tempDirectory();
  const { dbPath, db } = database(directory);
  seedLegacyDatabase(db);
  db.close();
  const report = inspectLegacyPaper(dbPath);
  const backupPath = join(directory, "backup.sqlite");

  await expect(
    applyLegacyPaperPurge({
      dbPath,
      manifestHash: undefined as unknown as string,
      backupPath,
    }),
  ).rejects.toThrow(/manifest-hash/);
  await expect(
    applyLegacyPaperPurge({
      dbPath,
      manifestHash: "not-a-hash",
      backupPath,
    }),
  ).rejects.toThrow(/manifest-hash/);
  await expect(
    applyLegacyPaperPurge({
      dbPath,
      manifestHash: "a".repeat(64),
      backupPath,
    }),
  ).rejects.toThrow(/清单哈希不匹配/);
  await expect(
    applyLegacyPaperPurge({
      dbPath,
      manifestHash: report.manifestHash,
      backupPath: "relative-backup.sqlite",
    }),
  ).rejects.toThrow(/绝对路径/);
  expect(existsSync(backupPath)).toBe(false);
  expect(inspectLegacyPaper(dbPath).manifest.totals.accounts).toBe(5);

  expect(() => inspectLegacyPaper("relative.sqlite")).toThrow(/绝对路径/);
  expect(parseCleanupArgs(["--db", dbPath])).toEqual({
    mode: "dry-run",
    dbPath,
  });
  expect(() =>
    parseCleanupArgs([
      "--db",
      dbPath,
      "--apply",
      "purge",
      "--backup",
      backupPath,
    ]),
  ).toThrow(/manifest-hash/);
});

it("falls back to the records audit store when paper_cleanup_receipts is absent", async () => {
  const directory = tempDirectory();
  const { dbPath, db } = database(directory);
  seedLegacyDatabase(db);
  db.exec("DROP TABLE paper_cleanup_receipts");
  db.close();

  const preview = inspectLegacyPaper(dbPath);
  const result = await applyLegacyPaperPurge({
    dbPath,
    manifestHash: preview.manifestHash,
    backupPath: join(directory, "backup.sqlite"),
  });
  expect(result.receipt.store).toBe("records");
  const after = new Database(dbPath);
  try {
    const row = after
      .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
      .get("paper-cleanup-receipt", result.receipt.id) as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({
      manifestHash: preview.manifestHash,
      removed: { accountIds: preview.manifest.accounts.map((a) => a.id) },
    });
  } finally {
    after.close();
  }
});

it("never purges a non-paper account id that reuses the frozen legacy candidates", async () => {
  const directory = tempDirectory();
  const { dbPath, db } = database(directory);
  const seeded = seedLegacyDatabase(db);
  const repo = new PaperRepository(db);
  const base = repo.account(seeded.ids[0]!)!;
  const lookalike: PaperAccount = {
    ...base,
    id: "custom:reused-frozen-candidates",
    candidates: [...base.candidates],
  };
  expect(repo.create(lookalike)).toBe(true);
  db.close();

  const preview = inspectLegacyPaper(dbPath);
  expect(preview.manifest.accounts.map((a) => a.id)).toEqual(seeded.ids);
  const custom = preview.manifest.excluded.custom.find(
    (entry) => entry.id === lookalike.id,
  );
  expect(custom).toBeDefined();
  expect(custom!.candidates).toEqual([
    {
      id: base.candidates[0]!.strategy.id,
      version: base.candidates[0]!.strategy.version,
    },
  ]);
  expect(preview.manifest.totals.accounts).toBe(5);

  const result = await applyLegacyPaperPurge({
    dbPath,
    manifestHash: preview.manifestHash,
    backupPath: join(directory, "provenance-backup.sqlite"),
  });
  expect(result.removed.accountIds).toEqual(seeded.ids);
  expect(result.removed.accountIds).not.toContain(lookalike.id);

  const after = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    expect(
      after
        .prepare("SELECT id FROM paper_accounts ORDER BY id")
        .all()
        .map((row) => (row as { id: string }).id),
    ).toEqual([seeded.customId, seeded.mixedId, lookalike.id].sort());
  } finally {
    after.close();
  }
});

it("aborts the purge when a same-count paper_state row changes after the backup", async () => {
  const directory = tempDirectory();
  const { dbPath, db } = database(directory);
  const seeded = seedLegacyDatabase(db);
  const protectedBefore = {
    import_batches: db
      .prepare("SELECT * FROM import_batches ORDER BY id")
      .all(),
    trade_fills: db.prepare("SELECT * FROM trade_fills ORDER BY id").all(),
    cash_flows: db.prepare("SELECT * FROM cash_flows ORDER BY id").all(),
    trade_ledger: db.prepare("SELECT * FROM trade_ledger ORDER BY id").all(),
  };
  db.close();

  const preview = inspectLegacyPaper(dbPath);
  expect(preview.manifest.totals.stateRows).toBe(5);
  const backupPath = join(directory, "drift-backup.sqlite");
  const targetId = seeded.ids[1]!;
  const realBackup = Database.prototype.backup;
  const spy = vi
    .spyOn(Database.prototype, "backup")
    .mockImplementation(async function (this: Database.Database, ...args) {
      const metadata = await (
        realBackup as (...a: unknown[]) => Promise<unknown>
      ).apply(this, args);
      // Same row count, different content, after the backup snapshot exists.
      this.prepare("UPDATE paper_state SET payload=? WHERE account_id=?").run(
        JSON.stringify({ marker: "mutated-after-backup" }),
        targetId,
      );
      return metadata as Awaited<ReturnType<typeof Database.prototype.backup>>;
    });

  try {
    await expect(
      applyLegacyPaperPurge({
        dbPath,
        manifestHash: preview.manifestHash,
        backupPath,
      }),
    ).rejects.toThrow(/备份后发生漂移/);
  } finally {
    spy.mockRestore();
  }

  expect(existsSync(backupPath)).toBe(true);
  const drifted = inspectLegacyPaper(dbPath);
  expect(drifted.manifest.totals).toEqual(preview.manifest.totals);
  expect(drifted.manifestHash).not.toBe(preview.manifestHash);

  const after = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    expect(
      after.prepare("SELECT count(*) n FROM paper_accounts").get(),
    ).toEqual({ n: 7 });
    expect(
      after
        .prepare("SELECT payload FROM paper_state WHERE account_id=?")
        .get(targetId),
    ).toEqual({ payload: JSON.stringify({ marker: "mutated-after-backup" }) });
    expect(
      after
        .prepare(
          "SELECT count(*) n FROM paper_cleanup_receipts WHERE action='purge'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect({
      import_batches: after
        .prepare("SELECT * FROM import_batches ORDER BY id")
        .all(),
      trade_fills: after.prepare("SELECT * FROM trade_fills ORDER BY id").all(),
      cash_flows: after.prepare("SELECT * FROM cash_flows ORDER BY id").all(),
      trade_ledger: after
        .prepare("SELECT * FROM trade_ledger ORDER BY id")
        .all(),
    }).toEqual(protectedBefore);
  } finally {
    after.close();
  }

  const backup = new Database(backupPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(
      backup
        .prepare("SELECT payload FROM paper_state WHERE account_id=?")
        .get(targetId),
    ).not.toEqual({
      payload: JSON.stringify({ marker: "mutated-after-backup" }),
    });
  } finally {
    backup.close();
  }
});

it("apply purge removes only exact legacy accounts, preserves real rows, and a later tick creates none", async () => {
  const directory = tempDirectory();
  const { dbPath, db } = database(directory);
  const seeded = seedLegacyDatabase(db);
  const protectedBefore = {
    import_batches: db
      .prepare("SELECT * FROM import_batches ORDER BY id")
      .all(),
    trade_fills: db.prepare("SELECT * FROM trade_fills ORDER BY id").all(),
    cash_flows: db.prepare("SELECT * FROM cash_flows ORDER BY id").all(),
    trade_ledger: db.prepare("SELECT * FROM trade_ledger ORDER BY id").all(),
  };
  db.close();

  const preview = inspectLegacyPaper(dbPath);
  const backupPath = join(directory, "legacy-backup.sqlite");
  const result = await applyLegacyPaperPurge({
    dbPath,
    manifestHash: preview.manifestHash,
    backupPath,
  });

  expect(result.removed.accountIds).toEqual(seeded.ids);
  expect(result.removed).toMatchObject({
    accounts: 5,
    stateRows: 5,
    factRows: 6,
  });
  expect(result.protected.before).toEqual(preview.manifest.protected);
  expect(result.protected.after).toEqual(preview.manifest.protected);
  expect(result.reservations).toEqual({
    released: ["paper-mirror-reservation-binance-demo"],
    retained: ["paper-mirror-reservation-ths-simulation"],
  });
  expect(result.receipt.store).toBe("paper_cleanup_receipts");
  expect(existsSync(backupPath)).toBe(true);

  const after = new Database(dbPath);
  after.pragma("foreign_keys = ON");
  try {
    expect(
      after
        .prepare("SELECT id FROM paper_accounts ORDER BY id")
        .all()
        .map((row) => (row as { id: string }).id),
    ).toEqual([seeded.customId, seeded.mixedId].sort());
    expect(after.prepare("SELECT count(*) n FROM paper_state").get()).toEqual({
      n: 0,
    });
    expect(after.prepare("SELECT count(*) n FROM paper_facts").get()).toEqual({
      n: 0,
    });
    expect(
      after
        .prepare(
          "SELECT id FROM records WHERE kind='paper-mirror-reservation' ORDER BY id",
        )
        .all()
        .map((row) => (row as { id: string }).id),
    ).toEqual([
      "paper-mirror-reservation-kept",
      "paper-mirror-reservation-ths-simulation",
    ]);
    expect({
      import_batches: after
        .prepare("SELECT * FROM import_batches ORDER BY id")
        .all(),
      trade_fills: after.prepare("SELECT * FROM trade_fills ORDER BY id").all(),
      cash_flows: after.prepare("SELECT * FROM cash_flows ORDER BY id").all(),
      trade_ledger: after
        .prepare("SELECT * FROM trade_ledger ORDER BY id")
        .all(),
    }).toEqual(protectedBefore);

    const receipt = after
      .prepare(
        "SELECT manifest_json,result_json FROM paper_cleanup_receipts WHERE manifest_hash=? AND action='purge'",
      )
      .get(preview.manifestHash) as {
      manifest_json: string;
      result_json: string;
    };
    expect(JSON.parse(receipt.manifest_json)).toEqual(preview.manifest);
    expect(JSON.parse(receipt.result_json)).toMatchObject({
      manifestHash: preview.manifestHash,
      removed: { accountIds: seeded.ids },
      reservations: result.reservations,
    });
  } finally {
    after.close();
  }

  const backup = new Database(backupPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(
      backup.prepare("SELECT count(*) n FROM paper_accounts").get(),
    ).toEqual({ n: 7 });
  } finally {
    backup.close();
  }

  // The live database no longer contains any legacy account, so the manifest
  // must now have zero targets while protected real data stays unchanged.
  const postPurge = inspectLegacyPaper(dbPath);
  expect(postPurge.manifest.totals.accounts).toBe(0);
  expect(postPurge.manifest.protected).toEqual(preview.manifest.protected);

  process.env.QUANT_DATA_DIR = directory;
  vi.resetModules();
  const { executePaperTick } = await import("~/server/paper/service");
  const dbModule = await import("~/server/db");
  try {
    const summaries = await executePaperTick({
      type: "paper-tick",
      now: Date.parse("2026-11-17T00:01:00Z"),
    });
    expect(summaries.some((account) => account.id.includes("r2a-"))).toBe(
      false,
    );
    const check = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(
        check
          .prepare("SELECT id FROM paper_accounts ORDER BY id")
          .all()
          .map((row) => (row as { id: string }).id),
      ).toEqual([seeded.customId, seeded.mixedId].sort());
    } finally {
      check.close();
    }
  } finally {
    dbModule.sqlite().close();
  }
});
