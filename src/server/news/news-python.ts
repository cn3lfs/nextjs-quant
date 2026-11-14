import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";

const startupFailure = (code?: string) =>
  new Error(
    `Python 启动失败${code ? `（${code}）` : ""}，请在“数据与连接设置 → 新闻采集”检查 Python 可执行文件及执行权限`,
  );

/** Diagnostic only: never runs classification, analysis, or model calls. */
export function newsPythonVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            startupFailure(
              error.killed ? "超时" : String(error.code ?? "退出异常"),
            ),
          );
          return;
        }
        const version = `${stdout}\n${stderr}`.trim();
        if (!/^Python \d+\.\d+(?:\.\d+)?[^\r\n]*$/.test(version)) {
          reject(
            new Error(
              "所选程序未返回 Python 版本，请检查新闻采集设置中的可执行文件",
            ),
          );
          return;
        }
        resolve(version);
      },
    );
  });
}

export async function runNewsPython(
  executable: string,
  script: string,
  args: string[],
  timeout: number,
) {
  try {
    if (!(await stat(script)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      "新闻技能脚本不可读取，请检查 QUANT_SKILLS_DIR 或用户目录下的 .agent-skills/skills 安装",
    );
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [script, ...args], {
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("新闻分析超时，未发布完成标记"));
    }, timeout);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(startupFailure(error.code));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(
              `新闻技能脚本退出异常（${code}），请检查 Python 环境和技能依赖`,
            ),
          );
    });
  });
}
