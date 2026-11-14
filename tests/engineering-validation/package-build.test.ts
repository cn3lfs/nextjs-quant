import { expect, it } from "vitest";
import { buildPackage } from "../../scripts/lib/package-build.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Install a real, private compiler once for these synthetic workspaces. Their
// location must not decide whether TypeScript is available via an ancestor.
const toolchainRoot = mkdtempSync(
  join(process.env.QUANT_DATA_DIR!, "package-toolchain-"),
);
const compilerRoot = join(toolchainRoot, "node_modules/typescript");
cpSync(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  compilerRoot,
  { recursive: true },
);

function fixture() {
  const workspaceRoot = mkdtempSync(join(toolchainRoot, "packages-"));
  mkdirSync(join(workspaceRoot, "packages"));
  writeFileSync(join(workspaceRoot, "package.json"), '{"private":true}');
  expect(
    createRequire(join(workspaceRoot, "package.json")).resolve(
      "typescript/bin/tsc",
    ),
  ).toBe(join(compilerRoot, "bin/tsc"));
  return workspaceRoot;
}
function packageAt(
  workspaceRoot: string,
  name: string,
  source: string,
  extra = {},
) {
  const packageRoot = join(workspaceRoot, "packages", name);
  mkdirSync(join(packageRoot, "src"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      ...extra,
    }),
  );
  writeFileSync(
    join(packageRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        declaration: true,
        rootDir: "src",
        outDir: "dist",
        types: [],
        skipLibCheck: true,
      },
      include: ["src/**/*.ts"],
    }),
  );
  writeFileSync(join(packageRoot, "src/index.ts"), source);
  return { workspaceRoot, packageRoot };
}
function emittedValue(packageRoot: string) {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {value} from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/index.js")).href)};console.log(value)`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

it("skips unchanged packages but recompiles edits, missing/tampered outputs and changed config", () => {
  const input = packageAt(
    fixture(),
    "sample",
    "export const value: number = 1;",
  );
  expect(buildPackage(input).status).toBe("built");
  expect(emittedValue(input.packageRoot)).toBe("1");
  expect(buildPackage(input).status).toBe("unchanged");
  writeFileSync(
    join(input.packageRoot, "src/index.ts"),
    "export const value: number = 2;",
  );
  expect(buildPackage(input).status).toBe("built");
  expect(emittedValue(input.packageRoot)).toBe("2");
  unlinkSync(join(input.packageRoot, "dist/index.d.ts"));
  expect(buildPackage(input).status).toBe("built");
  writeFileSync(
    join(input.packageRoot, "dist/index.js"),
    "export const value = 900;",
  );
  expect(buildPackage(input).status).toBe("built");
  expect(emittedValue(input.packageRoot)).toBe("2");
  const configPath = join(input.packageRoot, "tsconfig.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.compilerOptions.sourceMap = true;
  writeFileSync(configPath, JSON.stringify(config));
  expect(buildPackage(input).status).toBe("built");
  expect(existsSync(join(input.packageRoot, "dist/index.js.map"))).toBe(true);
});

it("rebuilds dependent packages and the worker bundle after a dependency changes", () => {
  const root = fixture();
  const library = packageAt(root, "library", "export const value: number = 1;");
  const consumer = packageAt(
    root,
    "consumer",
    'import {value as base} from "../../library/dist/index.js"; export const value = base + 1;',
    { dependencies: { library: "workspace:*" } },
  );
  expect(() => buildPackage(consumer)).toThrow("dependency library first");
  buildPackage(library);
  buildPackage(consumer);
  const worker = join(root, "worker.cjs");
  const bundle = () => {
    buildSync({
      stdin: {
        contents:
          'import {value} from "./packages/consumer/dist/index.js"; console.log(value);',
        resolveDir: root,
      },
      outfile: worker,
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    return execFileSync(process.execPath, [worker], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  };
  expect(bundle()).toBe("2");
  expect(buildPackage(consumer).status).toBe("unchanged");
  writeFileSync(
    join(library.packageRoot, "src/index.ts"),
    "export const value: number = 5;",
  );
  buildPackage(library);
  expect(buildPackage(consumer).status).toBe("built");
  expect(bundle()).toBe("6");
});

it("includes custom identity inputs, removes obsolete output, and never caches a failed compilation", () => {
  const root = fixture();
  const input = packageAt(root, "sample", "export const value: number = 1;", {
    quantBuild: { inputs: ["../../identity.txt"] },
  });
  writeFileSync(join(root, "identity.txt"), "first");
  writeFileSync(
    join(input.packageRoot, "src/retired.ts"),
    "export const retired = true;",
  );
  buildPackage(input);
  writeFileSync(join(root, "identity.txt"), "second");
  expect(buildPackage(input).status).toBe("built");
  unlinkSync(join(input.packageRoot, "src/retired.ts"));
  expect(buildPackage(input).status).toBe("built");
  expect(existsSync(join(input.packageRoot, "dist/retired.js"))).toBe(false);
  writeFileSync(
    join(input.packageRoot, "src/index.ts"),
    'export const value: number = "bad";',
  );
  expect(() => buildPackage(input)).toThrow();
  expect(existsSync(join(input.packageRoot, "dist/.quant-build.json"))).toBe(
    false,
  );
  expect(existsSync(join(input.packageRoot, ".quant-build.lock"))).toBe(false);
  writeFileSync(
    join(input.packageRoot, "src/index.ts"),
    "export const value: number = 3;",
  );
  expect(buildPackage(input).status).toBe("built");
  expect(emittedValue(input.packageRoot)).toBe("3");
});

it("rejects concurrent builds and does not overwrite a linked output directory", () => {
  const input = packageAt(fixture(), "sample", "export const value = 1;");
  const lock = join(input.packageRoot, ".quant-build.lock");
  writeFileSync(
    lock,
    JSON.stringify({
      tool: "quant-package-build",
      pid: process.pid,
      token: "fixture",
    }),
  );
  expect(() => buildPackage(input)).toThrow("already running");
  unlinkSync(lock);
  const external = join(input.workspaceRoot, "preserved");
  mkdirSync(external);
  writeFileSync(join(external, "keep.txt"), "preserve");
  const output = join(input.packageRoot, "dist");
  symlinkSync(
    external,
    output,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    expect(() => buildPackage(input)).toThrow("Linked build path");
    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("preserve");
  } finally {
    rmSync(output, { recursive: true });
  }
});

it("does not certify inputs that change during the post-compile identity step", () => {
  const input = packageAt(fixture(), "sample", "export const value = 1;", {
    quantBuild: { afterCompile: "identity.mjs" },
  });
  writeFileSync(
    join(input.packageRoot, "identity.mjs"),
    'import {writeFileSync} from "node:fs"; writeFileSync("src/index.ts", "export const value = 2;");',
  );
  expect(() => buildPackage(input)).toThrow("Inputs changed");
  expect(existsSync(join(input.packageRoot, "dist/.quant-build.json"))).toBe(
    false,
  );
  expect(existsSync(join(input.packageRoot, ".quant-build.lock"))).toBe(false);
});

it("refuses linked descendants before replacing output and recovers a verified dead process lock", () => {
  const input = packageAt(fixture(), "sample", "export const value = 1;");
  buildPackage(input);
  const external = join(input.workspaceRoot, "source-to-preserve");
  mkdirSync(external);
  writeFileSync(join(external, "keep.txt"), "preserve");
  const link = join(input.packageRoot, "dist/nested");
  symlinkSync(
    external,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    expect(() => buildPackage(input)).toThrow("Linked build input/output");
    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("preserve");
  } finally {
    rmSync(link, { recursive: true });
  }
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    windowsHide: true,
  });
  expect(dead.status).toBe(0);
  const lock = join(input.packageRoot, ".quant-build.lock");
  writeFileSync(
    lock,
    JSON.stringify({
      tool: "quant-package-build",
      pid: dead.pid,
      token: "dead-fixture",
    }),
  );
  expect(buildPackage(input).status).toBe("unchanged");
  expect(existsSync(lock)).toBe(false);
  expect(buildPackage({ ...input, force: true }).status).toBe("built");
});
