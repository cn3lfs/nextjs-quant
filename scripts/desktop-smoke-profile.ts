/**
 * Private seed for `desktop:smoke --startup-only`.
 *
 * The smoke runner owns one fresh mkdtemp profile and passes it as both argv
 * and QUANT_DATA_DIR. This process refuses anything else before it opens a
 * database, so a bad caller can never fall back to the user's real data root.
 * It then uses the application's own migrate/settings code to write an empty
 * local-market profile and a scheduler-owner lease held by the still-running
 * runner PID. Holding that lease keeps the scheduler and crypto ticks from
 * running; an empty proxy setting only means none is configured, not that
 * outbound access is blocked.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settingsSchema } from "../src/lib/domain";
import { put } from "../src/server/db";
import { processAlive } from "../src/server/infra/lease";
import { saveSettings } from "../src/server/infra/settings";

const mkdtempShape = /^quant-desktop-[A-Za-z0-9]{6}$/;

function normalizePath(value: string) {
  const absolute = resolve(value);
  // Windows paths are case-insensitive and may differ only in drive casing.
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function samePath(left: string, right: string) {
  return normalizePath(left) === normalizePath(right);
}

export function validateProfileDirectory({
  data,
  envData,
  parent = tmpdir(),
}: {
  data: string;
  envData: string | undefined;
  parent?: string;
}) {
  if (!data || !isAbsolute(data))
    throw new Error("smoke profile 必须是绝对路径");
  if (!envData || !isAbsolute(envData))
    throw new Error("QUANT_DATA_DIR 必须是绝对路径");
  if (!samePath(data, envData))
    throw new Error("caller 参数与 QUANT_DATA_DIR 不一致");
  const profile = resolve(data);
  if (!samePath(dirname(profile), parent))
    throw new Error("smoke profile 父目录不是当前临时目录");
  if (!mkdtempShape.test(basename(profile)))
    throw new Error("smoke profile 名称不是本次 quant-desktop- 形状");
  const info = lstatSync(profile);
  if (info.isSymbolicLink())
    throw new Error("smoke profile 不能是链接或重解析点");
  if (!info.isDirectory()) throw new Error("smoke profile 不是目录");
  // A junction can keep the same basename while pointing outside the temp
  // root. Resolve the real path and require it to stay in that root.
  const real = realpathSync.native(profile);
  if (!samePath(dirname(real), realpathSync.native(parent)))
    throw new Error("smoke profile 真实路径跳出临时目录");
  if (normalizePath(basename(real)) !== normalizePath(basename(profile)))
    throw new Error("smoke profile 真实名称被重定向");
  const entries = readdirSync(real);
  if (entries.some((entry) => entry.startsWith("quant.sqlite")))
    throw new Error("smoke profile 不能已有 SQLite 数据库");
  if (entries.length > 0) throw new Error("smoke profile 必须是空目录");
  return real;
}

export function validateRunnerPid({
  pid,
  ppid,
  alive = processAlive,
}: {
  pid: number;
  ppid: number;
  alive?: (pid: number) => boolean;
}) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("runner PID 必须是正整数");
  if (!alive(pid)) throw new Error("runner PID 不是活进程");
  // The seed must be a direct child of the runner, so the lease belongs to the
  // process that is actually waiting for the desktop child.
  if (ppid !== pid) throw new Error("seed 不是由 runner 直接启动");
  return pid;
}

function seedStartupOnlyProfile(data: string, runnerPid: number) {
  // Read the environment here, not from a caller-supplied copy: validation and
  // the database writes must agree on the same QUANT_DATA_DIR.
  const profile = validateProfileDirectory({
    data,
    envData: process.env.QUANT_DATA_DIR,
  });
  validateRunnerPid({ pid: runnerPid, ppid: process.ppid });
  const tdxRoot = join(profile, "tdx");
  const industryBlocksRoot = join(profile, "industry-blocks");
  const clsRoot = join(profile, "cls");
  mkdirSync(tdxRoot, { recursive: true });
  mkdirSync(industryBlocksRoot, { recursive: true });
  mkdirSync(clsRoot, { recursive: true });
  saveSettings(
    settingsSchema.parse({
      marketDataSource: "local",
      tdxRoot,
      industryBlocksRoot,
      industryMembershipSource: "blocks",
      clsDbPath: join(clsRoot, "cls.sqlite"),
      autoNewsAnalysis: false,
      outboundProxy: "",
    }),
  );
  // The lease row is the same shape the application writes. A live, different
  // PID makes every acquireScheduler() call in the server decline.
  put("lease", "scheduler-owner", { owner: randomUUID(), pid: runnerPid });
}

function main(argv: string[]) {
  const [data, rawPid, ...rest] = argv;
  if (!data || !rawPid || rest.length)
    throw new Error("用法：desktop-smoke-profile <data-dir> <runner-pid>");
  const runnerPid = Number(rawPid);
  if (!/^[1-9]\d*$/.test(rawPid)) throw new Error("runner PID 必须是正整数");
  seedStartupOnlyProfile(data, runnerPid);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
