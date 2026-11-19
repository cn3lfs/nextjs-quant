import { readdirSync, statSync } from "node:fs";
import { matchesGlob, resolve, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { configDefaults } from "vitest/config";
import { checkDependencies } from "../../scripts/lib/dependency-check";
import vitestConfig from "../../vitest.config";

const slash = (path: string) => path.replaceAll("\\", "/");
const fixture = /(?:^|\/)fixtures\//;

it("gives each component source a directory owner", () => {
  const files = readdirSync("src/components", { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[jt]sx?$/.test(entry.name))
    .map((entry) => entry.name);
  expect(files).toEqual([]);
});

it("resolves shared contracts and keeps UI and pure packages out of their hosts", async () => {
  const { modules } = await checkDependencies();
  const byPath = new Map(modules.map((module) => [module.source, module]));
  for (const entry of ["src/lib/domain.ts", "src/lib/common/classnames.ts"]) {
    expect(statSync(entry).isFile(), entry).toBe(true);
    expect(byPath.has(entry), entry).toBe(true);
  }

  const violations: string[] = [];
  for (const { source, dependencies } of modules) {
    const isShared = /^src\/(components|lib)\//.test(source);
    const isFoundation = source.startsWith("src/components/ui/");
    const isPackage = source.startsWith("packages/");
    if (!isShared && !isPackage) continue;
    for (const dep of dependencies) {
      const host = /^(src|electron|scripts|runtime)\//.test(dep.resolved);
      const server = dep.resolved.startsWith("src/server/");
      const runtime = !dep.dependencyTypes.includes("type-only");
      if (
        dep.couldNotResolve ||
        (isShared && runtime && server) ||
        (isFoundation && server) ||
        (isPackage && host)
      ) {
        violations.push(`${source} -> ${dep.module}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

it("routes every candidate suite to a runner and excludes fixture files", async () => {
  const candidates = readdirSync("tests", {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      slash(relative(process.cwd(), resolve(entry.parentPath, entry.name))),
    )
    .filter(
      (path) => fixture.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
    );
  const projects = await Promise.all(vitestConfig.test?.projects ?? []);
  const vitestProjects = projects.map((project) => {
    if (typeof project === "string" || typeof project === "function")
      throw new Error("Resolve the Vitest project before checking discovery");
    return project.test;
  });
  // The visual project selects a different candidate in the loaded profile.
  const playwrightConfigs: (typeof import("../../playwright.config").default)[] =
    [];
  try {
    vi.stubEnv("QUANT_E2E_PROJECTS", undefined);
    for (const loaded of ["0", "1"]) {
      vi.stubEnv("E2E_P1_ACCEPTANCE", loaded);
      vi.resetModules();
      playwrightConfigs.push((await import("../../playwright.config")).default);
    }
  } finally {
    vi.unstubAllEnvs();
  }
  const matches = (
    path: string,
    patterns: string | RegExp | (string | RegExp)[] | undefined,
  ) =>
    [patterns]
      .flat()
      .some((pattern) =>
        typeof pattern === "string"
          ? matchesGlob(path, `**/${pattern}`)
          : pattern?.test(path),
      );
  const playwrightDiscovered = (path: string) =>
    playwrightConfigs.some((config) =>
      (config.projects ?? []).some((project) => {
        const dir = slash(
          relative(
            process.cwd(),
            resolve(project.testDir ?? config.testDir ?? "."),
          ),
        );
        return (
          (!dir || path.startsWith(`${dir}/`)) &&
          matches(path, project.testMatch ?? config.testMatch) &&
          !matches(path, project.testIgnore ?? config.testIgnore)
        );
      }),
    );

  const misplaced: string[] = [];
  for (const path of candidates) {
    const vitestMatches = vitestProjects.filter(
      (project) =>
        (project?.include ?? configDefaults.include).some((pattern) =>
          matchesGlob(path, pattern),
        ) &&
        !(project?.exclude ?? configDefaults.exclude).some((pattern) =>
          matchesGlob(path, pattern),
        ),
    ).length;
    const inPlaywright = playwrightDiscovered(path);
    if (fixture.test(path)) {
      if (vitestMatches || inPlaywright)
        misplaced.push(`${path}: fixture is executed`);
    } else if (
      !/^tests\/[^/]+\//.test(path) ||
      vitestMatches + Number(inPlaywright) !== 1
    ) {
      misplaced.push(`${path}: must belong to a module and exactly one runner`);
    }
  }
  expect(misplaced).toEqual([]);
});
