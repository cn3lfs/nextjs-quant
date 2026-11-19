import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { settingsSchema } from "~/lib/domain";
import { openClsNewsDatabase } from "~/server/data-sources/cls/cls-database";
import { checkNewsSources } from "~/server/news/news-source-check";
import { newsSourceConfiguration } from "~/lib/settings/news-source-settings";

const python = vi.hoisted(() => vi.fn());
vi.mock("~/server/news/news-python", () => ({ newsPythonVersion: python }));
const root = process.env.QUANT_DATA_DIR!;
beforeEach(() => {
  python.mockReset().mockResolvedValue("Python 3.12.0");
});
function fixture(name: string) {
  const path = join(root, name);
  const database = new Database(path);
  database.exec(
    "CREATE TABLE news(id INTEGER PRIMARY KEY, ctime INTEGER, collected_at TEXT, title TEXT, content TEXT, shareurl TEXT)",
  );
  database.close();
  return path;
}
const source = (clsDbPath: string, newsPythonExecutable = "python") => ({
  clsDbPath,
  clsDbRole: "unspecified" as const,
  clsComplementDbPath: "",
  clsComplementDbRole: "" as const,
  newsPythonExecutable,
});

it("uses portable defaults and keeps a stored source path", () => {
  expect(newsSourceConfiguration(settingsSchema.parse({}))).toEqual({
    clsDbPath: "",
    clsDbRole: "unspecified",
    clsComplementDbPath: "",
    clsComplementDbRole: "",
    newsPythonExecutable: "python",
  });
  expect(
    settingsSchema.parse({ clsDbPath: " C:/existing/news.db " }).clsDbPath,
  ).toBe("C:/existing/news.db");
  expect(() => settingsSchema.parse({ newsPythonExecutable: " " })).toThrow();
  expect(() => settingsSchema.parse({ clsDbPath: "C:/bad\0.db" })).toThrow();
});

it("requires explicit, non-conflicting archive roles", () => {
  expect(
    settingsSchema.parse({ clsDbPath: "C:/a.db", clsDbRole: "red" }),
  ).toMatchObject({ clsDbRole: "red" });
  expect(() => settingsSchema.parse({ clsDbRole: "red" })).toThrow();
  expect(() =>
    settingsSchema.parse({
      clsDbPath: "C:/a.db",
      clsComplementDbPath: "C:/b.db",
    }),
  ).toThrow();
  expect(() =>
    settingsSchema.parse({
      clsDbPath: "C:/a.db",
      clsComplementDbRole: "red",
    }),
  ).toThrow();
  expect(() =>
    settingsSchema.parse({
      clsComplementDbPath: "C:/b.db",
      clsComplementDbRole: "red",
    }),
  ).toThrow();
  expect(() =>
    settingsSchema.parse({
      clsDbPath: "C:/a.db",
      clsDbRole: "all",
      clsComplementDbPath: "C:/b.db",
      clsComplementDbRole: "all",
    }),
  ).toThrow();
  expect(
    settingsSchema.parse({
      clsDbPath: "C:/a.db",
      clsDbRole: "all",
      clsComplementDbPath: "C:/b.db",
      clsComplementDbRole: "red",
    }),
  ).toMatchObject({ clsDbRole: "all", clsComplementDbRole: "red" });
  expect(
    settingsSchema.parse({
      clsDbPath: "C:/a.db",
      clsComplementDbPath: "C:/b.db",
      clsComplementDbRole: "red",
    }),
  ).toMatchObject({ clsDbRole: "unspecified", clsComplementDbRole: "red" });
  expect(() =>
    settingsSchema.parse({
      clsDbPath: "C:/a.db",
      clsDbRole: "all",
      clsComplementDbPath: "C:/A.DB",
      clsComplementDbRole: "red",
    }),
  ).toThrow();
});

it("checks only the saved snapshot, opens a valid source read-only, and preserves file bytes", async () => {
  const path = fixture("valid source.db");
  const before = readFileSync(path);
  const config = source(path, "custom-python");
  const result = await checkNewsSources(config, config);
  expect(result).toMatchObject({
    configuration: config,
    database: { ok: true },
    python: { ok: true, message: "Python 3.12.0" },
  });
  expect(python).toHaveBeenCalledExactlyOnceWith("custom-python");
  const connection = openClsNewsDatabase(path);
  try {
    expect(() => connection.exec("DELETE FROM news")).toThrow(/readonly/i);
  } finally {
    connection.close();
  }
  expect(readFileSync(path)).toEqual(before);
  python.mockClear();
  await expect(
    checkNewsSources(config, { ...config, clsDbPath: "old" }),
  ).rejects.toThrow("已变化");
  expect(python).not.toHaveBeenCalled();
});

it("reports unconfigured, missing, relative, non-file and invalid-schema paths without creating a source", async () => {
  const missing = join(root, "missing.db");
  const directory = join(root, "directory");
  mkdirSync(directory);
  const invalid = join(root, "text.db");
  writeFileSync(invalid, "not sqlite");
  const incomplete = join(root, "incomplete.db");
  const db = new Database(incomplete);
  db.exec("CREATE TABLE news(id INTEGER)");
  db.close();
  for (const [path, message] of [
    ["", "尚未配置"],
    [missing, "不存在"],
    ["relative.db", "绝对路径"],
    [directory, "不是文件"],
    [invalid, "SQLite"],
    [incomplete, "格式不符"],
  ]) {
    const config = source(path!);
    expect((await checkNewsSources(config, config)).database).toMatchObject({
      ok: false,
      message: expect.stringContaining(message!),
    });
  }
  expect(existsSync(missing)).toBe(false);
});

it("reports Python failures separately from the database result", async () => {
  const path = fixture("python-failure.db");
  python.mockRejectedValue(new Error("Python 不可执行"));
  const config = source(path, "missing-python");
  expect(await checkNewsSources(config, config)).toMatchObject({
    database: { ok: true },
    python: { ok: false, message: "Python 不可执行" },
  });
});
