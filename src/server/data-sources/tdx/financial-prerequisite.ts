import { relative } from "node:path";
import { financialDirectory } from "tstdx/local";

/** Only an absent report directory is a setup prerequisite; other IO failures remain errors. */
export function financialDirectoryPrerequisite(error: unknown, root: string) {
  const failure = error as NodeJS.ErrnoException & { path?: string };
  if (failure?.code === "TDX_ROOT_REQUIRED")
    return {
      code: "tdx-root-missing" as const,
      message:
        "通达信安装目录尚未配置。请在数据连接中设置目录，再刷新本地数据。",
    };
  if (
    failure?.code !== "ENOENT" ||
    typeof failure.path !== "string" ||
    relative(financialDirectory(root), failure.path) !== ""
  )
    return null;
  return {
    code: "financial-directory-missing" as const,
    message:
      "本地财务数据尚未准备好。请在通达信下载专业财务数据，并检查数据连接中的通达信目录。准备后点击“刷新本地数据”。",
  };
}
