import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, lstat, readdir, unlink, rmdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { dataDirectory } from "../db";
import type { Snapshot } from "~/lib/domain";

const filePattern = /^[a-f0-9-]{36}\.ndjson$/;
function spoolDirectory(jobId: string) {
  return join(
    dataDirectory(),
    "formula-screen-work",
    createHash("sha256").update(jobId).digest("hex"),
  );
}
async function rejectLink(path: string) {
  if ((await lstat(path)).isSymbolicLink())
    throw new Error("公式临时快照目录不能是链接");
}
/** Full histories stay on disk until global date alignment has completed. */
export async function createFormulaSnapshotSpool(jobId: string) {
  const directory = spoolDirectory(jobId);
  await mkdir(join(dataDirectory(), "formula-screen-work"), {
    recursive: true,
  });
  await rejectLink(join(dataDirectory(), "formula-screen-work"));
  await mkdir(directory);
  return directory;
}
export async function formulaSnapshotWriter(directory: string) {
  await rejectLink(directory);
  const file = join(directory, `${randomUUID()}.ndjson`);
  const handle = await open(file, "wx");
  return {
    file,
    async write(snapshot: Snapshot) {
      // Await each write: no unbounded stream buffer or batch of bar objects.
      await handle.writeFile(JSON.stringify(snapshot) + "\n", "utf8");
    },
    close: () => handle.close(),
  };
}
export async function* readFormulaSnapshots(
  jobId: string,
  files: readonly string[],
) {
  const directory = resolve(spoolDirectory(jobId));
  await rejectLink(join(dataDirectory(), "formula-screen-work"));
  await rejectLink(directory);
  // Reject every foreign pointer before opening any file, even if it exists.
  for (const file of files) {
    if (
      dirname(resolve(file)) !== directory ||
      !filePattern.test(basename(file))
    )
      throw new Error("公式快照指针不属于当前任务");
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("公式快照指针不是任务普通文件");
  }
  for (const file of files) {
    const input = createReadStream(file, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    });
    let pending = "";
    try {
      // Readable's async iterator applies backpressure while the caller saves
      // a batch. A readline event queue could otherwise retain the whole file.
      for await (const chunk of input) {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line) yield JSON.parse(line) as Snapshot;
        }
      }
      if (pending.trim()) yield JSON.parse(pending) as Snapshot;
    } finally {
      input.destroy();
    }
  }
}
/** Exact job-owned files only; unexpected entries are never recursively removed. */
export async function clearFormulaSnapshotSpool(jobId: string) {
  const directory = spoolDirectory(jobId);
  try {
    await rejectLink(join(dataDirectory(), "formula-screen-work"));
    await rejectLink(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    if (
      entries.some((entry) => !entry.isFile() || !filePattern.test(entry.name))
    )
      throw new Error("公式临时快照目录包含非本任务文件");
    for (const entry of entries) await unlink(join(directory, entry.name));
    await rmdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
