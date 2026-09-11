import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "scheduled wrappers parse in Windows PowerShell 5 with Chinese messages",
  () => {
    for (const name of [
      "workflow-task.ps1",
      "cls-workflow-task.ps1",
      "install-workflow-tasks.ps1",
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
