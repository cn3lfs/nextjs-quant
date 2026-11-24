import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import {
  directories,
  ensureRealDirectory,
  isAbsent,
  readBounded,
  UnsafeArchivePath,
} from "~/server/research/diagnose/archive-fs";
import {
  decodeCliLocation,
  discoverCliArchives,
  readCliReport,
} from "~/server/research/diagnose/cli-archive";

const archiveSources = {
  "src/server/research/diagnose/archive-fs.ts": [
    "lstat",
    "resolve",
    "realpath",
    "mkdir",
    "readdir",
    "open",
  ],
  "src/server/research/diagnose/cli-archive.ts": ["join", "readdir"],
};
const page = { page: 1, pageSize: 1, offset: 0 };
const noDrift = async () => [];

test("a current instrumentation trace excludes old desktop release files", async ({
  skip,
}) => {
  const traceDir = ".next/server";
  const manifest = join(traceDir, "instrumentation.js.nft.json");
  const trace = await stat(manifest).catch((error: unknown) => {
    if (!isAbsent(error)) throw error;
  });
  if (!trace)
    return skip("No instrumentation trace. Run after the Next build.");
  const sources = await Promise.all(
    Object.keys(archiveSources).map((source) => stat(source)),
  );
  if (sources.some((source) => source.mtimeMs > trace.mtimeMs))
    return skip("Instrumentation trace predates the archive sources.");

  const { files } = JSON.parse(await readFile(manifest, "utf8")) as {
    files: string[];
  };
  expect(Array.isArray(files)).toBe(true);
  expect(files.length).toBeGreaterThan(0);
  const paths = files.map((file) =>
    relative(process.cwd(), resolve(traceDir, file.replaceAll("\\", "/")))
      .replaceAll("\\", "/")
      .toLowerCase(),
  );
  expect(paths.filter((path) => path.startsWith("release/"))).toEqual([]);
  expect(
    paths.filter(
      (path) =>
        basename(path) === "czsc64.dll" &&
        path !== "runtime/czsc/czsc64.dll" &&
        path !== "vendor/czsc/czsc64.dll",
    ),
  ).toEqual([]);
});

test.each(Object.entries(archiveSources))(
  "%s annotates the runtime argument of each traced path operation",
  async (file, operations) => {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const seen = new Set<string>();
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        operations.includes(node.expression.text)
      ) {
        seen.add(node.expression.text);
        expect(
          node.arguments[0]?.getFullText(source).trim(),
          node.getText(),
        ).toMatch(/^\/\*\s*turbopackIgnore:\s*true\s*\*\//);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(seen).toEqual(new Set(operations));
  },
);

test("CLI archive IDs reject traversal and illegal Windows path segments", () => {
  const nestedId = (path: string) =>
    `cli-~${Buffer.from(path).toString("base64url")}`;
  expect(decodeCliLocation(nestedId("backtest-diagnose/batch/run"))).toEqual([
    "backtest-diagnose",
    "batch",
    "run",
  ]);
  for (const id of [
    "cli-../outside",
    "cli-..\\outside",
    "cli-C:drive",
    "cli-AUX.txt",
    "cli-report.",
    nestedId("backtest-diagnose/../outside"),
    nestedId("backtest-diagnose//run"),
    nestedId("outside/batch"),
  ]) {
    expect(() => decodeCliLocation(id), id).toThrow("非法诊断归档路径");
  }
});

test("CLI discovery skips directory links and archive I/O rejects linked paths", async () => {
  const sandbox = process.env.QUANT_DATA_DIR!;
  const base = join(sandbox, "cli-links");
  const outside = join(sandbox, "outside-cli-links");
  const linked = join(base, "linked");
  await mkdir(base);
  await mkdir(outside);
  await writeFile(join(outside, "report.md"), "# 回测诊断报告");
  await symlink(outside, linked, "junction");

  await expect(discoverCliArchives(base)).resolves.toEqual([]);
  await expect(directories(base, true)).rejects.toBeInstanceOf(
    UnsafeArchivePath,
  );
  await expect(
    readCliReport(base, ["linked"], page, noDrift),
  ).rejects.toBeInstanceOf(UnsafeArchivePath);
  await expect(
    readBounded(join(linked, "report.md"), 1024),
  ).rejects.toBeInstanceOf(UnsafeArchivePath);
  await expect(
    ensureRealDirectory(join(linked, "child")),
  ).rejects.toBeInstanceOf(UnsafeArchivePath);
});

test("bounded CLI reads keep complete CSV rows and exclude the truncated row", async () => {
  const base = join(process.env.QUANT_DATA_DIR!, "cli-bounds");
  const dir = join(base, "run");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({ strategyKey: "hold", symbols: ["sh600000"] }),
  );
  const csv = join(dir, "rejections.csv");
  const prefix = "orderId,date,reason\n1,2026-01-01,halted\n";
  await writeFile(csv, prefix);
  await expect(readBounded(csv, prefix.length)).resolves.toEqual({
    text: prefix,
    truncated: false,
  });
  await writeFile(
    csv,
    `${prefix}2,2026-01-02,${"x".repeat(2 * 1024 * 1024)}\n`,
  );
  await expect(readBounded(csv, prefix.length)).resolves.toEqual({
    text: prefix,
    truncated: true,
  });

  const detail = await readCliReport(base, ["run"], page, noDrift);
  expect(detail.cells[0]?.scenarios[0]).toMatchObject({
    sampleRejections: [{ orderId: 1, date: "2026-01-01", reason: "halted" }],
    rejectionReasons: [],
  });
  expect(detail.summary.driftWarnings).toContain(
    "rejections.csv 超出读取上限，仅显示已读取样本",
  );
});
