import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { resolveTdxRoot } from "tstdx/local";
import { daySchema, idSchema } from "./format";
import { MarketPanelHandle } from "./handle";
import { panelDirectory, rejectLink } from "./paths";
import { buildFiles } from "./builder";
import { discover, type BuildPanelOptions } from "./sources";

export { MarketPanelHandle, type MarketPanelSlice } from "./handle";
export {
  chunkSize,
  recordBytes,
  missingAtoms,
  panelFlags,
  type MarketPanelManifest,
  type MarketPanelSymbol,
  type PanelEvent,
  type PanelField,
} from "./format";
export type { BuildPanelOptions } from "./sources";
export { readWindowSnapshot } from "./window";

const pointerSchema = z.object({
  snapshotId: idSchema,
  previous: idSchema.nullable(),
});
const temporary =
  /^(stage|pointer)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
export class MarketPanelBusyError extends Error {}

/** A writer owns staging and retention while it holds writer.lock. Readers
 * pin read-only file descriptors. The next writer removes interrupted stages
 * and snapshots outside the current/previous pair. Cleanup errors propagate. */
export class MarketPanelStore {
  readonly root: string;
  constructor(root = "E:/new_tdx64") {
    this.root = resolveTdxRoot(root);
  }
  get directory() {
    return panelDirectory(this.root);
  }
  private pointer(directory: string) {
    const path = join(directory, "current.json");
    rejectLink(path);
    return pointerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }
  private openAt(directory: string, snapshotId: string) {
    idSchema.parse(snapshotId);
    return new MarketPanelHandle(
      join(directory, "snap-" + snapshotId),
      snapshotId,
    );
  }
  open(snapshotId: string) {
    return this.openAt(this.directory, snapshotId);
  }
  openLatest() {
    const directory = this.directory;
    const id = this.pointer(directory).snapshotId;
    try {
      return this.openAt(directory, id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const next = this.pointer(directory).snapshotId;
      if (next === id) throw e;
      return this.openAt(directory, next);
    }
  }
  private collect(dir: string, keep: readonly (string | null)[]) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const snapshot = e.isDirectory() && /^snap-[\da-f]{64}$/.test(e.name);
      if (
        !temporary.test(e.name) &&
        !(snapshot && !keep.includes(e.name.slice(5)))
      )
        continue;
      const path = join(dir, e.name);
      rejectLink(path);
      // Only descend through files owned by the panel writer. A foreign file
      // or directory is evidence of a configuration error, never GC input.
      if (e.isDirectory()) {
        const allowed = [
          "manifest.json",
          "panel.bin",
          "events.jsonl",
          "bands.tmp",
        ];
        for (const file of readdirSync(path, { withFileTypes: true })) {
          if (!file.isFile() || !allowed.includes(file.name))
            throw new Error("面板清理遇到未知文件");
        }
      }
      rmSync(path, { recursive: e.isDirectory(), force: true });
    }
  }
  async build(options: BuildPanelOptions = {}) {
    const { through } = options;
    const selection = { through, symbols: options.symbols?.slice() };
    if (through !== undefined) daySchema.parse(through);
    const root = realpathSync.native(this.root);
    const dir = this.directory;
    mkdirSync(dir, { recursive: true });
    // SQLite holds a kernel-managed exclusive file lock. Process death releases
    // it automatically. No PID probing, timeout-based stealing or business DB.
    const lockPath = join(dir, "writer.lock");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const stat = lstatSync(lockPath + suffix, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1))
        throw new Error("面板锁文件非法");
    }
    const lock = new Database(lockPath, { timeout: 0 });
    try {
      try {
        // eslint-disable-next-line repositories/no-raw-sqlite -- Dedicated cache lock file only. The business repository cannot provide a crash-released lock spanning asynchronous file IO.
        lock.exec("BEGIN EXCLUSIVE");
      } catch (e) {
        if ((e as { code?: string }).code === "SQLITE_BUSY")
          throw new MarketPanelBusyError("面板正在构建");
        throw e;
      }
      await new Promise<void>((r) => setImmediate(r));
      const current = lstatSync(join(dir, "current.json"), {
        throwIfNoEntry: false,
      })
        ? this.pointer(dir)
        : null;
      this.collect(dir, [
        current?.snapshotId ?? null,
        current?.previous ?? null,
      ]);
      const input = await discover(root, selection);
      let previous = current?.snapshotId ?? null;
      if (current) {
        let handle: MarketPanelHandle | undefined;
        try {
          handle = this.openAt(dir, current.snapshotId);
          if (handle.manifest.sourceFingerprint === input.fingerprint) {
            await handle.verify();
            return handle;
          }
        } catch {
          // Leave the pointer in place until the staged replacement verifies.
          previous = current.previous;
        }
        handle?.close();
      }
      const nonce = randomUUID(),
        stage = join(dir, "stage-" + nonce + ".tmp"),
        next = join(dir, "pointer-" + nonce + ".tmp");
      mkdirSync(stage);
      try {
        const manifest = await buildFiles(stage, input, through);
        const verify = new MarketPanelHandle(stage, manifest.snapshotId);
        try {
          await verify.verify();
        } finally {
          verify.close();
        }
        if ((await discover(root, selection)).fingerprint !== input.fingerprint)
          throw new Error("面板来源在发布前变化");
        renameSync(stage, join(dir, "snap-" + manifest.snapshotId));
        const pointer = {
          snapshotId: manifest.snapshotId,
          previous,
        };
        writeFileSync(next, JSON.stringify(pointer), {
          flag: "wx",
          flush: true,
        });
        renameSync(next, join(dir, "current.json"));
        this.collect(dir, [pointer.snapshotId, pointer.previous]);
        return this.openAt(dir, pointer.snapshotId);
      } finally {
        rmSync(stage, { recursive: true, force: true });
        rmSync(next, { force: true });
      }
    } finally {
      lock.close();
    }
  }
}
export const buildMarketPanel = (
  root = "E:/new_tdx64",
  options: BuildPanelOptions = {},
) => new MarketPanelStore(root).build(options);
export function openMarketPanel(snapshotId?: string, root = "E:/new_tdx64") {
  const store = new MarketPanelStore(root);
  return snapshotId === undefined ? store.openLatest() : store.open(snapshotId);
}
