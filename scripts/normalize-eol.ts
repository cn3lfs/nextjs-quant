import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// `.gitattributes` stores every text file with LF, but tooling that writes
// through PowerShell leaves CRLF in the working copy, which then makes
// `git diff --check` fail for reasons unrelated to the change under review.
// Normalize only files git already reports as modified or untracked, and never
// the byte-exact source snapshots: their line endings are the author's content.
const excluded = /^docs\/trading-skills-source-snapshots\//;
const text = /\.(ts|tsx|mjs|cjs|js|json|md|yml|yaml|css|html)$/;

const status = execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
});
const candidates = status
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
  .filter((path) => !excluded.test(path));

const files: string[] = [];
const walk = (path: string) => {
  let entry;
  try {
    entry = statSync(path);
  } catch {
    return; // Deleted or renamed away since `git status` ran.
  }
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) walk(`${path}/${child}`);
    return;
  }
  if (text.test(path) && !excluded.test(path)) files.push(path);
};
for (const path of candidates) walk(path);

const changed: string[] = [];
for (const path of files) {
  const bytes = readFileSync(resolve(path));
  if (!bytes.includes("\r\n")) continue;
  writeFileSync(path, bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
  changed.push(path);
}
console.log(
  changed.length
    ? `已归一化 ${changed.length} 个文件为 LF：\n${changed.join("\n")}`
    : "无 CRLF 残留",
);
