import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "loads the external downloader as UTF-8 and propagates its failure",
  () => {
    const root = mkdtempSync(resolve(tmpdir(), "quant-utf8-downloader-"));
    try {
      const script = resolve(root, "download.ps1");
      writeFileSync(
        script,
        "param([switch]$MarketOnly)\n# 中文下载脚本，无BOM\nWrite-Output $MarketOnly.IsPresent\nexit 7\n",
        "utf8",
      );
      const wrapper = readFileSync(
        resolve("scripts/workflow-task.ps1"),
        "utf8",
      );
      const loader = wrapper.match(/\$loader = '([^']+)'/)?.[1];
      expect(loader).toBeTruthy();
      for (const enabled of ["1", "0"]) {
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-EncodedCommand",
            Buffer.from(loader!, "utf16le").toString("base64"),
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 15000,
            env: {
              ...process.env,
              QUANT_TDX_DOWNLOADER: script,
              QUANT_TDX_MARKET_ONLY: enabled,
            },
          },
        );
        expect(result.status).toBe(7);
        expect(result.stdout.trim()).toBe(enabled === "1" ? "True" : "False");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "scheduled wrappers parse in Windows PowerShell 5 with Chinese messages",
  () => {
    for (const name of [
      "workflow-task.ps1",
      "cls-workflow-task.ps1",
      "install-workflow-tasks.ps1",
      "increment-close-task.ps1",
      "install-increment-close-task.ps1",
    ]) {
      const path = resolve("scripts", name);
      expect([...readFileSync(path).subarray(0, 3)]).toEqual([239, 187, 191]);
      const result = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$errors=$null;$tokens=$null;[System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors) > $null; if($errors){$errors | ForEach-Object {$_.Message};exit 1}`,
        ],
        { windowsHide: true, encoding: "utf8", timeout: 15000 },
      );
      expect(result.trim()).toBe("");
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "close wrapper rejects stale packages without touching data and preserves pending exit status",
  () => {
    const root = mkdtempSync(resolve(tmpdir(), "quant-close-wrapper-"));
    const data = resolve(root, "isolated-data");
    try {
      mkdirSync(resolve(root, "node-runtime"));
      mkdirSync(resolve(root, "runtime"));
      copyFileSync(process.execPath, resolve(root, "node-runtime/node.exe"));
      const runner = resolve(root, "runtime/workflow-runner.cjs");
      const run = (check = false) =>
        spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve("scripts/increment-close-task.ps1"),
            "-ServerDirectory",
            root,
            "-DataDirectory",
            data,
            ...(check ? ["-CheckOnly"] : []),
          ],
          { encoding: "utf8", windowsHide: true, timeout: 15000 },
        );
      writeFileSync(runner, "throw new Error('old runner must never start');");
      expect(run(true).status).toBe(1);
      expect(existsSync(data)).toBe(false);
      writeFileSync(
        runner,
        `// --close-rps-increment\nconsole.log(JSON.stringify({data:process.env.QUANT_DATA_DIR,cwd:process.cwd(),args:process.argv.slice(2)}));process.exitCode=2;`,
      );
      const check = run(true);
      expect(check.status).toBe(0);
      expect(JSON.parse(check.stdout).status).toBe("ready");
      expect(existsSync(data)).toBe(false);
      const executed = run();
      expect(executed.status).toBe(2);
      expect(JSON.parse(executed.stdout)).toEqual({
        data,
        cwd: root,
        args: ["--close-rps-increment"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
