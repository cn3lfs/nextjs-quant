import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { newsPythonVersion, runNewsPython } from "~/server/news/news-python";

const root = process.env.QUANT_DATA_DIR!;
it("passes literal arguments and UTF-8 to the configured executable without a shell", async () => {
  const script = join(root, "参数 fixture.cjs");
  const output = join(root, "argv.json");
  writeFileSync(
    script,
    "require('node:fs').writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),encoding:process.env.PYTHONIOENCODING}))",
  );
  const args = ["带 空格", "$(whoami); & echo never-run", 'quote"value'];
  await runNewsPython(process.execPath, script, [output, ...args], 5000);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
    args,
    encoding: "utf-8",
  });
});

it("distinguishes missing scripts, unavailable executables and non-Python version output", async () => {
  await expect(
    runNewsPython(process.execPath, join(root, "absent.py"), [], 5000),
  ).rejects.toThrow("技能脚本");
  await expect(
    newsPythonVersion(join(root, "absent-python.exe")),
  ).rejects.toThrow("Python 启动失败");
  await expect(newsPythonVersion(process.execPath)).rejects.toThrow(
    "未返回 Python 版本",
  );
});

it("rejects failed and timed-out scripts", async () => {
  const failed = join(root, "failed.cjs");
  writeFileSync(failed, "process.exit(7)");
  await expect(
    runNewsPython(process.execPath, failed, [], 5000),
  ).rejects.toThrow("退出异常（7）");
  const slow = join(root, "slow.cjs");
  writeFileSync(slow, "setInterval(()=>{},1000)");
  await expect(runNewsPython(process.execPath, slow, [], 100)).rejects.toThrow(
    "超时",
  );
});
