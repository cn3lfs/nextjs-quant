import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readBlockEligibility } from "../src/server/market/block-eligibility";
import {
  applyBlockRebuild,
  planBlockRebuild,
} from "../src/server/screening/rps-block-maintenance";

// Operational database is explicit; imported adapters must never acquire the default application DB.
if (!process.env.QUANT_DATA_DIR) throw new Error("先设置隔离 QUANT_DATA_DIR");
const options = new Map<string, string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--database", "--tdx-root", "--plan", "--apply"].includes(args[i]!) ||
    !args[i + 1] ||
    options.has(args[i]!)
  )
    throw new Error("参数须为唯一的 --database/--tdx-root/--plan/--apply 值");
  options.set(args[i]!, args[i + 1]!);
}
if (
  !options.get("--database") ||
  !!options.get("--plan") === !!options.get("--apply")
)
  throw new Error("必须显式指定数据库，并选择 --plan 或 --apply");
const database = resolve(options.get("--database")!);
const work = resolve((options.get("--plan") ?? options.get("--apply"))!);
if (
  resolve(process.env.QUANT_DATA_DIR) === dirname(database) ||
  work === dirname(database) ||
  work === database
)
  throw new Error("隔离目录、计划目录与正式库必须分开");
const applying = options.has("--apply");
const db = new Database(database, {
  readonly: !applying,
  fileMustExist: true,
  timeout: 10000,
});
let stage: Database.Database | undefined;
try {
  const setting = db
    .prepare("SELECT payload FROM records WHERE id='settings'")
    .get() as { payload: string } | undefined;
  const root =
    options.get("--tdx-root") ??
    (setting
      ? (JSON.parse(setting.payload) as { tdxRoot?: string }).tdxRoot
      : undefined);
  if (!root) throw new Error("没有通达信分类目录，请显式指定 --tdx-root");
  const policy = await readBlockEligibility(root);
  if (!applying) {
    await mkdir(dirname(work), { recursive: true });
    await mkdir(work); // Refuse to overwrite a prior plan or backup.
    stage = new Database(join(work, "plan.sqlite"));
    const summary = planBlockRebuild(db, stage, policy);
    await writeFile(join(work, "plan.json"), JSON.stringify(summary, null, 2));
    console.log(
      JSON.stringify({
        mode: "plan",
        work,
        changes: summary.changes,
        observations: summary.observations,
        daily: summary.daily,
        dates: summary.dates,
        removed: summary.removed,
        stockHash: summary.stockHash,
        policyHash: policy.hash,
      }),
    );
  } else {
    stage = new Database(join(work, "plan.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    const backup = join(work, "before.sqlite");
    await writeFile(backup, "", { flag: "wx" });
    await db.backup(backup);
    const verify = new Database(backup, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      if (
        verify.pragma("quick_check", { simple: true }) !== "ok" ||
        verify.pragma("user_version", { simple: true }) !==
          db.pragma("user_version", { simple: true })
      )
        throw new Error("备份数据库核验失败，未修改正式结果");
    } finally {
      verify.close();
    }
    const result = applyBlockRebuild(db, stage, policy);
    await writeFile(
      join(work, "applied.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(
      JSON.stringify({
        mode: "applied",
        backup,
        changes: result.changes,
        observations: result.observations,
        dates: result.dates,
        removed: result.removed,
        stockHash: result.stockHash,
      }),
    );
  }
} finally {
  stage?.close();
  db.close();
}
