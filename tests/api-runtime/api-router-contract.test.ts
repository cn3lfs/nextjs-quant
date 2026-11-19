/// <reference types="vite/client" />
import { expect, it } from "vitest";
import { appRouter } from "~/server/api/root";

type ProcedureKind = "query" | "mutation";

type DomainRouter = {
  _def: {
    router: true;
    procedures: Record<string, { _def: { type: string } }>;
  };
};

function isRouter(value: unknown): value is DomainRouter {
  if (typeof value !== "object" || value === null || !("_def" in value))
    return false;
  const def = value._def;
  return (
    typeof def === "object" &&
    def !== null &&
    "router" in def &&
    def.router === true &&
    "procedures" in def
  );
}

const domains = import.meta.glob("../../src/server/api/routers/**/*.ts", {
  eager: true,
}) as Record<string, Record<string, unknown>>;

it("registers every exported domain procedure once at its flat wire path", () => {
  const registered: DomainRouter["_def"]["procedures"] =
    appRouter._def.procedures;
  const owners = new Map<string, string>();
  const seenRouters = new Set<DomainRouter>();

  for (const [file, exports] of Object.entries(domains)) {
    for (const [name, router] of Object.entries(exports)) {
      if (!isRouter(router) || seenRouters.has(router)) continue;
      // A barrel or export alias can expose the same router object.
      seenRouters.add(router);
      const domain = `${file} (${name})`;
      for (const [path, procedure] of Object.entries(router._def.procedures)) {
        expect(path, `${domain} must register a flat procedure`).not.toContain(
          ".",
        );
        expect(
          owners.get(path),
          `${path} also exported by ${domain}`,
        ).toBeUndefined();
        owners.set(path, domain);

        expect(["query", "mutation"], `${domain}: ${path}`).toContain(
          procedure._def.type,
        );
        expect(
          Object.hasOwn(registered, path),
          `${domain}: missing ${path}`,
        ).toBe(true);
        expect(registered[path]?._def.type, `${domain}: ${path}`).toBe(
          procedure._def.type,
        );
        expect(registered[path], `${domain}: wrong handler at ${path}`).toBe(
          procedure,
        );
      }
    }
  }

  expect(owners.size).toBeGreaterThan(0);
  expect(Object.keys(registered).filter((path) => !owners.has(path))).toEqual(
    [],
  );
});

it.each([
  ["chartBars", "query"],
  ["snapshot", "mutation"],
  ["formulaScreen", "mutation"],
  ["quickSearchSecurities", "query"],
  ["strategyLabCompareRuns", "query"],
  ["taskHistory", "query"],
  ["saveSettings", "mutation"],
] satisfies [string, ProcedureKind][])(
  "keeps %s exposed as a %s",
  (path, kind) => {
    expect(
      (appRouter._def.procedures as DomainRouter["_def"]["procedures"])[path]
        ?._def.type,
    ).toBe(kind);
  },
);
