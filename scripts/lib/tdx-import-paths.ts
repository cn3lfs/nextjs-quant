import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export async function tdxImportTargets(directory: string) {
  if (process.platform !== "win32") throw new Error("此入口仅支持 Windows");
  const processes = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (/^"(?:tdxw|tdxsp|tdxnonsp)\.exe"/im.test(processes))
    throw new Error("请先关闭通达信");
  const root = await realpath(directory),
    targets: Record<string, string> = {};
  for (const market of ["sh", "sz"]) {
    const path = await realpath(join(root, "vipdoc", market, "fzline"));
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("目标五分钟目录位于安装目录之外");
    targets[market] = path;
  }
  return { root, targets };
}
