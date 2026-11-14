import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { settingsSchema } from "~/lib/domain";
import { saveSettings, settings } from "~/server/infra/settings";
import { get, sqlite } from "~/server/db";
import { runClsNewsBatch } from "~/server/news/cls-news-workflow";

const run = vi.hoisted(() => vi.fn());
vi.mock("~/server/news/news-python", () => ({ runNewsPython: run }));
const root = process.env.QUANT_DATA_DIR!;
const now = Date.parse("2026-11-13T08:00:00+08:00");
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  run.mockReset();
});
function source(name: string, populated: boolean) {
  const path = join(root, name);
  const db = new Database(path);
  db.exec(
    "CREATE TABLE news(id INTEGER PRIMARY KEY,ctime INTEGER,collected_at TEXT,title TEXT,content TEXT,shareurl TEXT)",
  );
  if (populated)
    db.prepare(
      "INSERT INTO news VALUES(1,?,NULL,'fixture news','fixture body',NULL)",
    ).run(now / 1000 - 10);
  db.close();
  return path;
}

it("uses the configured database and freezes Python configuration across both batch steps", async () => {
  const path = source("configured.db", true);
  const before = readFileSync(path);
  const config = settingsSchema.parse({
    clsDbPath: path,
    newsPythonExecutable: "initial-python",
  });
  saveSettings(config);
  vi.stubEnv("QUANT_SKILLS_DIR", join(root, "isolated-skills"));
  run.mockImplementation(
    async (executable: string, script: string, args: string[]) => {
      expect(executable).toBe("initial-python");
      expect(script).toContain("isolated-skills");
      if (script.endsWith("classify.py")) {
        const input = JSON.parse(readFileSync(args[0]!, "utf8"));
        expect(input.items.map((row: { id: number }) => row.id)).toEqual([1]);
        writeFileSync(
          join(dirname(args[0]!), "news_raw_classified.json"),
          JSON.stringify({ industries: { 电子: [{ id: 1 }] } }),
        );
        saveSettings({
          ...config,
          clsDbPath: join(root, "new-source.db"),
          newsPythonExecutable: "next-python",
        });
      } else throw new Error("fixture stops before model analysis");
    },
  );
  try {
    await expect(
      runClsNewsBatch("morning", now, join(root, "reports")),
    ).rejects.toThrow("fixture stops");
  } finally {
    vi.unstubAllEnvs();
  }
  expect(run).toHaveBeenCalledTimes(2);
  expect(settings().newsPythonExecutable).toBe("next-python");
  expect(readFileSync(path)).toEqual(before);
  expect(get("cls-news-checkpoint")).toBeUndefined();
  expect(get("cls-analysis-2026-11-13-morning")).toBeUndefined();
});

it("returns an empty batch without launching Python and rejects missing configuration without creating a source", async () => {
  saveSettings(settingsSchema.parse({ clsDbPath: source("empty.db", false) }));
  expect(
    await runClsNewsBatch("morning", now, join(root, "empty-reports")),
  ).toMatchObject({ status: "empty" });
  expect(run).not.toHaveBeenCalled();
  saveSettings(settingsSchema.parse({ clsDbPath: "" }));
  await expect(
    runClsNewsBatch("noon", now, join(root, "missing-reports")),
  ).rejects.toThrow("尚未配置");
  expect(existsSync(join(root, "missing-reports"))).toBe(false);
});
