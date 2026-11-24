import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { dataDirectory } from "../../infra/paths";

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

/** Resolve existing ancestors even before the cache has been created. */
function physical(path: string): string {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info) return realpathSync.native(path);
  const parent = dirname(path);
  return parent === path ? path : join(physical(parent), basename(path));
}
export function outsideTdx(cache: string, source: string) {
  const target = physical(resolve(cache));
  for (const root of [
    source,
    ...(process.platform === "win32" ? ["E:/new_tdx64"] : []),
  ]) {
    if (
      contains(physical(resolve(root)), target) ||
      contains(resolve(root), resolve(cache))
    )
      throw new Error("缓存目录不能位于通达信只读目录内");
  }
}
export function panelDirectory(source: string) {
  const data = resolve(dataDirectory());
  const path = join(data, "market-panel");
  outsideTdx(path, source);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error("面板目录不能是链接");
  return path;
}
export function rejectLink(path: string) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error("面板文件不能是链接");
}
