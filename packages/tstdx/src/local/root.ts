import { isAbsolute, resolve } from "node:path";

/** An unconfigured client must never become process.cwd() through path.resolve. */
export function resolveTdxRoot(root: string): string {
  if (typeof root !== "string" || !root.trim())
    throw Object.assign(new Error("通达信安装目录尚未配置"), {
      code: "TDX_ROOT_REQUIRED",
    });
  if (
    !isAbsolute(root) ||
    root.includes("\0") ||
    (process.platform === "win32" &&
      !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(root))
  )
    throw Object.assign(new Error("通达信安装目录必须是有效的绝对路径"), {
      code: "TDX_ROOT_INVALID",
    });
  return resolve(root);
}
