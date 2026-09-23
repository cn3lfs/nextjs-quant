import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
const guardsPath = "../../scripts/desktop-guards.mjs";
const preparePath = "../../scripts/prepare-desktop.mjs";
const {
  assertDesktopClosed,
  assertStandaloneReady,
  prepareAdvice,
  startAdvice,
} = await import(guardsPath);
const { runPrepare } = await import(preparePath);

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "quant-t4-"));
  roots.push(root);
  for (const directory of [
    ".next/static/chunks",
    ".next/standalone/.next/static/chunks",
  ]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(
      join(root, directory, "current.js"),
      "console.log('current')",
    );
  }
  for (const file of [
    ".next/BUILD_ID",
    ".next/standalone/.next/BUILD_ID",
    ".next/standalone/.next/desktop-prepared-build-id",
  ]) {
    await writeFile(join(root, file), "build-current");
  }
  await writeFile(
    join(root, ".next/standalone/server.js"),
    "console.log('SERVER_STARTED');",
  );
  return root;
}

it("T4 stops preparation before any copy or removal when this checkout is occupied", async () => {
  const root = await fixture();
  const copy = vi.fn();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = vi.fn((..._args: any[]) => {
    throw Object.assign(new Error("Command failed: raw stack"), {
      stdout: "node.exe PID 1234",
    });
  });
  expect(
    await runPrepare({
      root,
      copy,
      guard: () => assertDesktopClosed(root, run, "win32"),
    }),
  ).toBe(1);
  expect(copy).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(`${prepareAdvice}\nnode.exe PID 1234`);
  expect(
    await readFile(
      join(root, ".next/standalone/.next/desktop-prepared-build-id"),
      "utf8",
    ),
  ).toBe("build-current");
  expect(
    await readFile(
      join(root, ".next/standalone/.next/static/chunks/current.js"),
      "utf8",
    ),
  ).toContain("current");
  const [exe, args, options] = run.mock.calls[0]!;
  expect(exe).toBe("powershell.exe");
  expect(options.env.QUANT_PREPARE_ROOT).toBe(resolve(root));
  expect(options.windowsHide).toBe(true);
  const script = args.at(-1);
  expect(script).toContain("Get-CimInstance Win32_Process");
  expect(script).toContain("$release + '\\'");
  expect(script).toContain("$standalone + '\\'");
  expect(script).toContain("[IO.FileShare]::None");
  expect(script).not.toMatch(/Stop-Process|Remove-Item/);
});

it.each(["EPERM", "EBUSY", "EACCES"])(
  "T4 converts a late %s copy failure to actionable text without a stack",
  async (code) => {
    const root = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const path = join(root, ".next/standalone/runtime/czsc/CZSC64.dll");
    expect(
      await runPrepare({
        root,
        guard: () => {},
        copy: async () => {
          throw Object.assign(new Error("raw unlink stack"), { code, path });
        },
      }),
    ).toBe(1);
    expect(log).toHaveBeenCalledWith(`${prepareAdvice}\n无法写入：${path}`);
    await expect(assertStandaloneReady(root)).rejects.toThrow(startAdvice);
  },
);

it("T4 reports an unavailable process check and never proceeds blindly", () => {
  expect(() =>
    assertDesktopClosed(
      "C:/checkout",
      () => {
        throw new Error("CIM denied");
      },
      "win32",
    ),
  ).toThrow("无法确认目标文件未被占用");
});

it("T4 marks preparation complete only after every copy succeeds and removes obsolete chunks", async () => {
  const root = await fixture();
  const marker = join(root, ".next/standalone/.next/desktop-prepared-build-id");
  await writeFile(
    join(root, ".next/standalone/.next/static/chunks/obsolete.js"),
    "old",
  );
  const { cp } = await import("node:fs/promises");
  const copy = vi.fn(async (source: string, destination: string) => {
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    if (source === join(root, ".next/static"))
      await cp(source, destination, { recursive: true });
  });
  expect(await runPrepare({ root, guard: () => {}, copy })).toBe(0);
  expect(copy).toHaveBeenCalledTimes(7);
  expect(await readFile(marker, "utf8")).toBe("build-current");
  await expect(assertStandaloneReady(root)).resolves.toBeUndefined();
});

it("T4 allows matching build IDs and static files to launch the server", async () => {
  const root = await fixture();
  await expect(assertStandaloneReady(root)).resolves.toBeUndefined();
  const result = spawnSync(process.execPath, [resolve("scripts/start.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, QUANT_DATA_DIR: join(root, "data") },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("SERVER_STARTED");
});

it.each([
  "old-build",
  "old-marker",
  "missing-marker",
  "missing-chunk",
  "wrong-size",
  "extra-chunk",
  "empty-static",
])("T4 refuses %s before spawning an HTTP server", async (kind) => {
  const root = await fixture();
  const bundled = join(root, ".next/standalone/.next");
  if (kind === "old-build")
    await writeFile(join(bundled, "BUILD_ID"), "old-build");
  if (kind === "old-marker")
    await writeFile(join(bundled, "desktop-prepared-build-id"), "old-build");
  if (kind === "missing-marker")
    await rm(join(bundled, "desktop-prepared-build-id"));
  if (kind === "missing-chunk")
    await rm(join(bundled, "static/chunks/current.js"));
  if (kind === "wrong-size")
    await writeFile(join(bundled, "static/chunks/current.js"), "truncated");
  if (kind === "extra-chunk")
    await writeFile(join(bundled, "static/chunks/stale.js"), "stale");
  if (kind === "empty-static") {
    await rm(join(root, ".next/static/chunks/current.js"));
    await rm(join(bundled, "static/chunks/current.js"));
  }
  const result = spawnSync(process.execPath, [resolve("scripts/start.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, QUANT_DATA_DIR: join(root, "data") },
  });
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain("SERVER_STARTED");
  expect(result.stderr.trim()).toBe(startAdvice);
});
