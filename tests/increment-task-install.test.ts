import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// Execute the real installer with in-memory ScheduledTasks cmdlets. No task,
// backup, production data, or executable is created by this harness.
function install(mode: "success" | "enable-failure" | "stale") {
  const code = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$global:events=[Collections.Generic.List[string]]::new()
$global:mode=$env:QUANT_INSTALL_TEST_MODE
$global:taskTimes=@('12:00','15:30','20:00')
$global:created=$false
function Get-ScheduledTask {
 param($TaskName,$ErrorAction)
 if($TaskName -ne 'TDX_DailyDownload'){return}
 [pscustomobject]@{TaskName=$TaskName;State='Ready';Principal=[pscustomobject]@{};Triggers=@($global:taskTimes | ForEach-Object {[pscustomobject]@{StartBoundary=('2026-09-11T' + $_ + ':00')}})}
}
function powershell.exe {
 $global:events.Add('check-package')
 $global:LASTEXITCODE=0
 if($global:mode -eq 'stale'){$global:LASTEXITCODE=1}
}
function New-Item {param($ItemType,$Path,$ErrorAction) $global:events.Add('backup-directory')}
function Export-ScheduledTask {param($TaskName,$ErrorAction) '<Task />'}
function Set-Content {param($LiteralPath,$Encoding,[Parameter(ValueFromPipeline=$true)]$Value) process {}}
function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{Execute=$Execute;Argument=$Argument}}
function New-ScheduledTaskSettingsSet {
 param($MultipleInstances,$ExecutionTimeLimit,$RestartCount,$RestartInterval)
 if($MultipleInstances -ne 'IgnoreNew' -or $RestartCount -ne 1 -or $RestartInterval.TotalMinutes -ne 15){throw 'wrong retry settings'}
 [pscustomobject]@{Enabled=$true}
}
function New-ScheduledTask {param($Action,$Trigger,$Settings,$Principal) [pscustomobject]@{Settings=$Settings}}
function Register-ScheduledTask {
 param($TaskName,$InputObject,$ErrorAction)
 if($InputObject.Settings.Enabled){throw 'must register disabled'}
 $global:created=$true;$global:events.Add('register-disabled')
}
function Set-ScheduledTask {
 param($TaskName,$Trigger,$ErrorAction)
 $global:taskTimes=@($Trigger | ForEach-Object {([datetime]$_.StartBoundary).ToString('HH:mm')})
 $global:events.Add('set:' + ($global:taskTimes -join ','))
}
function Enable-ScheduledTask {
 param($TaskName,$ErrorAction)
 $global:events.Add('enable')
 if($global:mode -eq 'enable-failure'){throw 'simulated enable failure'}
}
function Unregister-ScheduledTask {param($TaskName,$Confirm,$ErrorAction) $global:created=$false;$global:events.Add('unregister')}
$failure=$null
try { & $env:QUANT_INSTALL_TEST_SCRIPT -Apply | Out-Null } catch { $failure=$_.Exception.Message }
@{events=@($global:events);times=$global:taskTimes;created=$global:created;failure=$failure} | ConvertTo-Json -Compress
`;
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(code, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        env: {
          ...process.env,
          QUANT_INSTALL_TEST_MODE: mode,
          QUANT_INSTALL_TEST_SCRIPT: resolve(
            "scripts/install-increment-close-task.ps1",
          ),
        },
      },
    ),
  ) as {
    events: string[];
    times: string[];
    created: boolean;
    failure: string | null;
  };
}

it.skipIf(process.platform !== "win32")(
  "switches only the close trigger after package validation and backup",
  () => {
    const result = install("success");
    expect(result.failure).toBeNull();
    expect(result.times).toEqual(["12:00", "20:00"]);
    expect(result.created).toBe(true);
    expect(result.events).toEqual([
      "check-package",
      "backup-directory",
      "register-disabled",
      "set:12:00,20:00",
      "enable",
    ]);
  },
);
it.skipIf(process.platform !== "win32")(
  "restores the original triggers and removes only the newly created task after failure",
  () => {
    const result = install("enable-failure");
    expect(result.failure).toContain("simulated enable failure");
    expect(result.times).toEqual(["12:00", "15:30", "20:00"]);
    expect(result.created).toBe(false);
    expect(result.events.slice(-2)).toEqual([
      "set:12:00,15:30,20:00",
      "unregister",
    ]);
  },
);
it.skipIf(process.platform !== "win32")(
  "does not write backups or tasks when the package is stale",
  () => {
    const result = install("stale");
    expect(result.failure).not.toBeNull();
    expect(result.times).toEqual(["12:00", "15:30", "20:00"]);
    expect(result.events).toEqual(["check-package"]);
    expect(result.created).toBe(false);
  },
);
