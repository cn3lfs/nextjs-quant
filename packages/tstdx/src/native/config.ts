import { resolve } from "node:path";
let directory = resolve("runtime/tdx-import");
/** Call before the first native operation. DLL deployment is owned by the host. */
export function configureTdxNativeDirectory(path: string) {
  directory = resolve(path);
}
export function localNativePath(name: string) {
  if (!/^[a-z0-9-]+\.dll$/.test(name)) throw new Error("原生库名称非法");
  return resolve(directory, name);
}
