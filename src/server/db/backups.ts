import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve, parse, relative } from "node:path";
import { z } from "zod";
import { dataDirectory, get, put, sqlite } from ".";
import { claimWorkflow } from "./workflow-lease";

export const backupSettingsSchema = z
  .object({ keep: z.number().int().min(1).max(30).default(3) })
  .strict();
const owned = /^quant-\d{13}-[a-f0-9-]{36}\.sqlite$/;
async function backupRoot() {
  const root = resolve(dataDirectory(), "backups");
  // Do not follow a redirected directory when pruning old backups.
  let current = parse(root).root;
  for (const part of relative(current, root).split(/[\\/]/)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("备份目录不可包含目录链接");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return root;
}
export const backupSettings = () =>
  backupSettingsSchema.parse(get("system-backup-settings") ?? {});
export function saveBackupSettings(value: unknown) {
  return put(
    "system-backup-settings",
    "system-backup-settings",
    backupSettingsSchema.parse(value),
  );
}
export async function databaseStatus() {
  const root = await backupRoot();
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const backups = [];
  for (const name of names
    .filter((n) => owned.test(n))
    .sort()
    .reverse()) {
    const path = join(root, name),
      info = await lstat(path);
    if (info.isFile() && !info.isSymbolicLink())
      backups.push({ path, at: Number(name.slice(6, 19)), bytes: info.size });
  }
  return {
    version: sqlite().pragma("user_version", { simple: true }) as number,
    database: join(resolve(dataDirectory()), "quant.sqlite"),
    root,
    keep: backupSettings().keep,
    backups,
    latest: backups[0]?.at ?? null,
  };
}
/** SQLite online backup includes committed WAL pages. Only successful owned
 * backups count toward retention; failed/pending copies never replace them.
 * A crash leaves at most one pending file per lease; the next owner removes it.
 */
export async function backupDatabase() {
  const lease = claimWorkflow("database-backup");
  if (!lease) throw new Error("数据库备份正在进行，请稍后查看状态");
  let pending: string | undefined;
  try {
    const root = await backupRoot(),
      name = `quant-${Date.now()}-${randomUUID()}.sqlite`;
    pending = join(root, `${name}.pending`);
    await mkdir(root, { recursive: true });
    for (const entry of await readdir(root)) {
      if (!entry.endsWith(".pending") || !owned.test(entry.slice(0, -8)))
        continue;
      const path = join(root, entry),
        info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) await rm(path);
    }
    await sqlite().backup(pending);
    lease.assert();
    // Runtime user-data file, never a bundled project asset.
    if ((await stat(/* turbopackIgnore: true */ pending)).size === 0)
      throw new Error("数据库备份为空");
    await rename(pending, join(root, name));
    const status = await databaseStatus();
    for (const old of status.backups.slice(status.keep)) {
      lease.assert();
      await rm(old.path);
    }
    return databaseStatus();
  } finally {
    try {
      if (pending) await rm(pending, { force: true });
    } finally {
      lease.release();
    }
  }
}
