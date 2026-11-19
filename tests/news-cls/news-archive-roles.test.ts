import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newsFixtureCutoff } from "../helpers/news-workspace-fixture";
import {
  freezeNewsWorkspacePage,
  newsWorkspaceDetail,
  newsWorkspacePage,
} from "../../src/server/db/news-workspace-query";
import {
  newsArchiveOptions,
  newsSourceIdentity,
  sameArchiveFile,
} from "../../src/server/news/news-archives";
import { readClsNews } from "../../src/server/data-sources/cls/cls-news";
import { newsPageSelectionSchema } from "../../src/lib/news/news-workspace";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const directory = mkdtempSync(join(tmpdir(), "quant-news-role-"));
  directories.push(directory);
  return directory;
}
function seed(path: string, label: string, count = 121) {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE news(id INTEGER PRIMARY KEY,ctime INTEGER,collected_at TEXT,title TEXT,content TEXT,shareurl TEXT)",
  );
  const insert = db.prepare("INSERT INTO news VALUES(?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 1; i <= count; i++)
      insert.run(
        i,
        Math.floor(newsFixtureCutoff / 1000) - i,
        "2025-01-07 15:59:30",
        `${label}标题${i}`,
        `${label}正文${i} `.repeat(20),
        `https://example.com/${label}/${i}`,
      );
  })();
  db.close();
  return path;
}
function pair() {
  const root = directory(),
    primaryPath = seed(join(root, "primary.sqlite"), "主"),
    complementPath = seed(join(root, "complement.sqlite"), "备");
  return {
    primaryPath,
    complementPath,
    config: {
      clsDbPath: primaryPath,
      clsDbRole: "all" as const,
      clsComplementDbPath: complementPath,
      clsComplementDbRole: "red" as const,
    },
  };
}
const input = { cutoff: newsFixtureCutoff, historical: true };
const titles = (prefix: string) =>
  Array.from({ length: 50 }, (_, i) => `${prefix}标题${i + 1}`);

it("switches between declared roles without merging same ids", () => {
  const { config, primaryPath } = pair();
  const all = newsWorkspacePage(config, input),
    red = newsWorkspacePage(config, { ...input, role: "red" }),
    explicitAll = newsWorkspacePage(config, { ...input, role: "all" });
  expect(all.archive).toEqual({
    key: "primary",
    role: "all",
    label: "全部电报",
    primary: true,
  });
  expect(red.archive).toEqual({
    key: "complement",
    role: "red",
    label: "加红电报",
    primary: false,
  });
  expect(all.source).not.toBe(red.source);
  expect(explicitAll.source).toBe(all.source);
  expect(all.items[0]).toMatchObject({ id: 1, title: "主标题1" });
  expect(red.items[0]).toMatchObject({ id: 1, title: "备标题1" });
  expect(all.items[0]!.hash).not.toBe(red.items[0]!.hash);
  expect(all.total).toBe(121);
  expect(red.total).toBe(121);
  expect(all.items.map((n) => n.hash)).toEqual(
    readClsNews(primaryPath, input)
      .items.slice(0, 50)
      .map((n) => n.hash),
  );
});

it("keeps pagination inside the selected archive and rejects a cursor from the other role", () => {
  const { config } = pair();
  const firstAll = newsWorkspacePage(config, input),
    secondAll = newsWorkspacePage(config, {
      ...input,
      cursor: firstAll.nextCursor!,
    }),
    firstRed = newsWorkspacePage(config, { ...input, role: "red" }),
    secondRed = newsWorkspacePage(config, {
      ...input,
      role: "red",
      cursor: firstRed.nextCursor!,
    });
  expect(firstAll.items.map((n) => n.title)).toEqual(titles("主"));
  expect(secondAll.items[0]!.title).toBe("主标题51");
  expect(firstRed.items.map((n) => n.title)).toEqual(titles("备"));
  expect(secondRed.items[0]!.title).toBe("备标题51");
  expect(
    new Set([...firstAll.items, ...secondAll.items].map((n) => n.id)).size,
  ).toBe(100);
  expect(() =>
    newsWorkspacePage(config, {
      ...input,
      role: "all",
      cursor: firstRed.nextCursor!,
    }),
  ).toThrow(/分页/);
  expect(() =>
    newsWorkspacePage(config, {
      ...input,
      role: "red",
      cursor: firstAll.nextCursor!,
    }),
  ).toThrow(/分页/);
});

it("opens originals only from the selected archive and rejects the same id from the other source", () => {
  const { config } = pair();
  const all = newsWorkspacePage(config, input),
    red = newsWorkspacePage(config, { ...input, role: "red" });
  expect(
    newsWorkspaceDetail(config, { ...input, role: "red" }, 1, red.source),
  ).toMatchObject({
    item: { title: "备标题1" },
    archive: { key: "complement", primary: false },
  });
  expect(() =>
    newsWorkspaceDetail(config, { ...input, role: "all" }, 1, red.source),
  ).toThrow(/来源/);
  expect(() =>
    newsWorkspaceDetail(config, { ...input, role: "red" }, 1, all.source),
  ).toThrow(/来源/);
  expect(() => newsWorkspaceDetail(config, input, 1, red.source)).toThrow(
    /来源/,
  );
  expect(newsWorkspaceDetail(config, input, 1, all.source).item.title).toBe(
    "主标题1",
  );
});

it("does not freeze a complementary page against the primary archive", () => {
  const { config, primaryPath } = pair();
  const red = newsWorkspacePage(config, { ...input, role: "red" }),
    selection = {
      source: red.source,
      fingerprint: red.fingerprint,
      role: "red" as const,
    };
  expect(newsPageSelectionSchema.parse(selection).role).toBe("red");
  expect(() =>
    freezeNewsWorkspacePage(primaryPath, { ...input, role: "red" }, selection),
  ).toThrow(/来源/);
});

it("requires a declared role and never falls back to the primary archive", () => {
  const { primaryPath } = pair();
  const unspecified = {
    clsDbPath: primaryPath,
    clsDbRole: "unspecified" as const,
    clsComplementDbPath: "",
    clsComplementDbRole: "" as const,
  };
  expect(newsWorkspacePage(unspecified, input).archive).toEqual({
    key: "primary",
    role: "unspecified",
    label: "当前资料（未注明）",
    primary: true,
  });
  expect(() =>
    newsWorkspacePage(unspecified, { ...input, role: "all" }),
  ).toThrow(/未配置「全部电报」档案/);
  expect(() =>
    newsWorkspacePage(unspecified, { ...input, role: "red" }),
  ).toThrow(/未配置「加红电报」档案/);
  expect(() =>
    newsWorkspacePage(
      { ...unspecified, clsDbRole: "all" },
      { ...input, role: "red" },
    ),
  ).toThrow(/未配置「加红电报」档案/);
  expect(newsArchiveOptions(unspecified).unconfigured).toEqual([
    { role: "all", label: "全部电报" },
    { role: "red", label: "加红电报" },
  ]);
});

it("presents one source when both roles point to the same file", () => {
  const { primaryPath } = pair();
  const same = {
    clsDbPath: primaryPath,
    clsDbRole: "all" as const,
    clsComplementDbPath: primaryPath,
    clsComplementDbRole: "red" as const,
  };
  const options = newsArchiveOptions(same);
  expect(options.options).toHaveLength(2);
  expect(
    options.options.find((option) => option.key === "complement"),
  ).toMatchObject({
    available: false,
    message: expect.stringContaining("同一文件"),
  });
  expect(options.note).toContain("同一文件");
  expect(newsWorkspacePage(same, input).archive.key).toBe("primary");
  expect(() => newsWorkspacePage(same, { ...input, role: "red" })).toThrow(
    /同一文件/,
  );
  const unspecified = { ...same, clsDbRole: "unspecified" as const };
  expect(
    newsArchiveOptions(unspecified).options.find(
      (option) => option.key === "complement",
    ),
  ).toMatchObject({ available: false });
  expect(() =>
    newsWorkspacePage(unspecified, { ...input, role: "red" }),
  ).toThrow(/同一文件/);
  expect(newsWorkspacePage(unspecified, input).archive.label).toBe(
    "当前资料（未注明）",
  );
});

it("detects a hardlink or junction as the same file without using the path hash", () => {
  const root = directory();
  const target = join(root, "target");
  mkdirSync(target);
  const primaryPath = seed(join(target, "primary.sqlite"), "主");
  const hardlink = join(root, "hardlink.sqlite");
  let linkedPath = hardlink;
  let junction: string | undefined;
  try {
    linkSync(primaryPath, hardlink);
  } catch {
    junction = join(root, "junction");
    symlinkSync(
      target,
      junction,
      process.platform === "win32" ? "junction" : "dir",
    );
    linkedPath = join(junction, "primary.sqlite");
  }
  try {
    // The R3 source hash includes the path, so it differs for both link forms.
    expect(newsSourceIdentity(primaryPath)).not.toBe(
      newsSourceIdentity(linkedPath),
    );
    expect(sameArchiveFile(primaryPath, linkedPath)).toBe(true);
    const otherPath = seed(join(root, "other.sqlite"), "备");
    expect(sameArchiveFile(primaryPath, otherPath)).toBe(false);
    const config = {
      clsDbPath: primaryPath,
      clsDbRole: "all" as const,
      clsComplementDbPath: linkedPath,
      clsComplementDbRole: "red" as const,
    };
    expect(
      newsArchiveOptions(config).options.find(
        (option) => option.key === "complement",
      ),
    ).toMatchObject({
      available: false,
      message: expect.stringContaining("同一文件"),
    });
    expect(newsWorkspacePage(config, input).archive.key).toBe("primary");
    expect(() => newsWorkspacePage(config, { ...input, role: "red" })).toThrow(
      /同一文件/,
    );
  } finally {
    if (junction) {
      try {
        if (process.platform === "win32") rmdirSync(junction);
        else unlinkSync(junction);
      } catch {
        /* afterEach removes the isolation root. */
      }
    }
  }
});

it("reports a missing or unreadable complement without falling back to the primary archive", () => {
  const { config } = pair();
  const missing = {
    ...config,
    clsComplementDbPath: join(directory(), "missing.sqlite"),
  };
  expect(
    newsArchiveOptions(missing).options.find(
      (option) => option.key === "complement",
    ),
  ).toMatchObject({ available: false, message: "文件不存在" });
  expect(() => newsWorkspacePage(missing, { ...input, role: "red" })).toThrow(
    /文件不存在/,
  );
  expect(newsWorkspacePage(missing, input).archive.key).toBe("primary");
  expect(
    newsWorkspacePage(missing, { ...input, role: "all" }).archive.key,
  ).toBe("primary");

  const unreadable = { ...config, clsComplementDbPath: directory() };
  expect(
    newsArchiveOptions(unreadable).options.find(
      (option) => option.key === "complement",
    ),
  ).toMatchObject({ available: false, message: "不是文件" });
  expect(() =>
    newsWorkspacePage(unreadable, { ...input, role: "red" }),
  ).toThrow(/不是文件/);
  expect(newsWorkspacePage(unreadable, input).archive.key).toBe("primary");
});

it("reports a missing primary and a role without a path explicitly", () => {
  const missing = join(directory(), "missing.sqlite");
  const config = {
    clsDbPath: missing,
    clsDbRole: "unspecified" as const,
    clsComplementDbPath: "",
    clsComplementDbRole: "" as const,
  };
  expect(() => newsWorkspacePage(config, input)).toThrow(
    /新闻主档案不可读取：文件不存在/,
  );
  const roleWithoutPath = {
    clsDbPath: "",
    clsDbRole: "red" as const,
    clsComplementDbPath: "",
    clsComplementDbRole: "" as const,
  };
  expect(newsArchiveOptions(roleWithoutPath).note).toContain("未填写路径");
  expect(() =>
    newsWorkspacePage(roleWithoutPath, { ...input, role: "red" }),
  ).toThrow(/未配置「加红电报」档案/);
  const complementWithoutRole = {
    clsDbPath: missing,
    clsDbRole: "unspecified" as const,
    clsComplementDbPath: missing,
    clsComplementDbRole: "" as const,
  };
  expect(newsArchiveOptions(complementWithoutRole).note).toContain(
    "未声明类型",
  );
});
