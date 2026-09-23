import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import ts from "typescript";
import type { z } from "zod";
import { tradingMethodMapSchema } from "./trading-method-map";
import { researchCompositePresetIds } from "../../src/lib/research/specs/research-composite-presets";

export type MethodMap = z.infer<typeof tradingMethodMapSchema>;
export type MethodEvidence = {
  owners: Map<string, string>;
  exports: Map<string, Set<string>>;
  imports: Map<string, Set<string>>;
  tests: Set<string>;
  files: Set<string>;
};
const gbbqAvailableMethods = new Set([
  "VP01",
  "VP02",
  "VP03",
  "VP04",
  "VP05",
  "VP06",
  "VP07",
  "VP08",
  "VP09",
  "VP11",
  "VP12",
  "VP15",
  "VP-small-float-turnover",
  "VP-controlled-contraction",
  "VP-dry-turnover-confirm",
  "VP-turnover-bands",
  "VP-turnover-location",
  "VP-float-break",
]);
const gbbqCoverageNote =
  "R1-1 本机只读汇总（E:/new_tdx64）：6149 个证券、18,344,968 根日线，其中 16,634,968 根（90.6786427%）有生效日流通股本，1,710,000 根缺口；4632 个证券全覆盖、942 个部分覆盖、575 个无覆盖，覆盖区间 1990-12-19 至 2026-09-16，127,317 条有效股本事件。研究运行仍按逐证券缺口返回 missing，不使用当前股本回算历史。";
export function syncMethodDelivery(map: MethodMap) {
  const next = structuredClone(map);
  for (const method of next.methods) {
    if (method.delivery) {
      if (gbbqAvailableMethods.has(method.id))
        method.delivery.data = {
          status: "available",
          note: gbbqCoverageNote,
        };
      continue;
    }
    const implementation =
      method.status === "implemented"
        ? ("complete" as const)
        : method.status === "implemented-variant"
          ? ("engineering" as const)
          : ("planned" as const);
    const data = gbbqAvailableMethods.has(method.id)
      ? {
          status: "available" as const,
          note: gbbqCoverageNote,
        }
      : method.id === "CH11"
        ? {
            status: "partial" as const,
            note: "current-membership-v1 可运行，但含成分偏差与存活偏差；availableAt 的时点正确语义仍缺失，只作参考。",
          }
        : /待数据|数据缺口|尚未接通|真实历史.*未知|未接入|缺少.*历史/.test(
              method.boundary,
            )
          ? {
              status: "missing" as const,
              note: "当前边界仍登记数据缺口；本轮不以固定夹具或当前值替代真实历史覆盖。",
            }
          : {
              status: "unknown" as const,
              note: "本轮未执行 R3 真实历史覆盖核验；实现存在不等于数据可用。",
            };
    method.delivery = {
      implementation: {
        status: implementation,
        note:
          implementation === "complete"
            ? "method.status=implemented；已登记完整实现入口。"
            : implementation === "engineering"
              ? "method.status=implemented-variant；具名工程版本已登记，不能等同完整原文。"
              : "method.status=planned；尚无可验收实现入口。",
      },
      data,
      realBacktest: {
        status: "pending",
        resultRecords: [],
        note: "R3 尚未运行；本轮不预填真实回测完成。",
      },
      effect: {
        status: "pending",
        note: "没有真实回测结果，不得形成效果结论。",
      },
    };
  }
  return next;
}
export const legacyPresetBoundaries: Record<string, string> = {
  "dual-breakout": "既有基线，不把尚未完整实现的SW01整体升级为完成",
  "dual-breakout-structure": "既有结构风险基线，独立风险组件由具名导出绑定",
  "ma-cross": "既有MA趋势基线，不等同新增交叉方法",
  czsc: "既有DLL基线，不等同缠论全方法覆盖",
};
export function collectMethodEvidence(
  families: readonly { file: string; ids: readonly string[] }[],
  root = process.cwd(),
): MethodEvidence {
  const slash = (s: string) => s.replaceAll("\\", "/");
  const files = new Set(
    ["src", "tests"].flatMap((dir) =>
      readdirSync(resolve(root, dir), { recursive: true })
        .map(String)
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => `${dir}/${slash(f)}`),
    ),
  );
  const imports = new Map<string, Set<string>>(),
    exports = new Map<string, Set<string>>(),
    tests = new Set<string>();
  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const dependencies = new Set<string>(),
      names = new Set<string>();
    for (const node of ast.statements) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !node.importClause?.isTypeOnly
      ) {
        const id = node.moduleSpecifier.text;
        const base = id.startsWith("~/")
          ? resolve(root, "src", id.slice(2))
          : id.startsWith(".")
            ? resolve(root, dirname(file), id)
            : null;
        if (base) {
          const target = [
            base,
            `${base}.ts`,
            `${base}.tsx`,
            `${base}/index.ts`,
          ].find((p) => existsSync(p) && /\.tsx?$/.test(p));
          if (target) dependencies.add(slash(relative(root, target)));
        }
      }
      if (
        ts.canHaveModifiers(node) &&
        ts
          .getModifiers(node)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        if (ts.isFunctionDeclaration(node) && node.name && node.body)
          names.add(node.name.text);
        if (ts.isVariableStatement(node))
          for (const declaration of node.declarationList.declarations)
            if (ts.isIdentifier(declaration.name) && declaration.initializer)
              names.add(declaration.name.text);
      }
    }
    imports.set(file, dependencies);
    exports.set(file, names);
    if (
      file.endsWith(".test.ts") &&
      /\b(?:it|test)(?:\.each)?[\s(]/.test(source) &&
      /\bexpect\s*\(/.test(source)
    )
      tests.add(file);
  }
  return {
    files,
    imports,
    exports,
    tests,
    owners: new Map([
      ...families.flatMap((f) => f.ids.map((id) => [id, f.file] as const)),
      ...researchCompositePresetIds.map(
        (id) => [id, "src/lib/research/specs/research-composite-presets.ts"] as const,
      ),
    ]),
  };
}
export function reconcileMethodEvidence(
  map: MethodMap,
  evidence: MethodEvidence,
) {
  const next = structuredClone(map);
  const errors: string[] = [];
  const changes: { id: string; before: unknown; after: unknown }[] = [];
  const bound = new Set<string>();
  const reaches = (
    file: string,
    target: string,
    seen = new Set<string>(),
  ): boolean => {
    if (file === target) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return [...(evidence.imports.get(file) ?? [])].some((f) =>
      reaches(f, target, seen),
    );
  };
  for (const method of next.methods) {
    const bindings = method.bindings;
    if (!bindings) {
      if (method.status !== "planned")
        errors.push(`${method.id}: implemented method lacks bindings`);
      continue;
    }
    const owners: string[] = [];
    for (const preset of bindings.presets) {
      bound.add(preset);
      const owner = evidence.owners.get(preset);
      if (!owner)
        errors.push(`${method.id}: preset has no implementation: ${preset}`);
      else owners.push(owner);
    }
    for (const binding of bindings.exports) {
      if (
        !evidence.exports.get(binding.file)?.has(binding.name) ||
        !reaches("src/server/backtest/research-run.ts", binding.file)
      )
        errors.push(
          `${method.id}: executable export missing/unreachable: ${binding.file}#${binding.name}`,
        );
      else owners.push(binding.file);
    }
    if (!owners.length) {
      errors.push(`${method.id}: no implementation or tests`);
      continue;
    }
    // Existing semantic test declarations remain mandatory. Discover new direct consumers,
    // plus the registry-driven contracts; an empty or deleted test is not evidence.
    const discovered = [...evidence.tests].filter((test) =>
      owners.some(
        (owner) =>
          (method.tests.includes(test) && reaches(test, owner)) ||
          (test.endsWith(`/${basename(owner, ".ts")}.test.ts`) &&
            reaches(test, owner)),
      ),
    );
    if (bindings.presets.length)
      for (const test of [
        "tests/research-backtest/research-contracts.test.ts",
        "tests/research-backtest/research-registry-ui.test.ts",
      ]) {
        if (
          evidence.tests.has(test) &&
          reaches(test, "src/lib/research/specs/research-strategies.ts")
        )
          discovered.push(test);
      }
    if (
      bindings.presets.length &&
      owners.includes("src/lib/research/specs/research-composite-presets.ts") &&
      evidence.tests.has("tests/research-backtest/research-composite-presets.test.ts") &&
      reaches(
        "tests/research-backtest/research-composite-presets.test.ts",
        "src/lib/research/specs/research-composite-presets.ts",
      )
    )
      discovered.push("tests/research-backtest/research-composite-presets.test.ts");
    for (const test of method.tests)
      if (!evidence.tests.has(test))
        errors.push(`${method.id}: declared test missing/empty: ${test}`);
    if (!discovered.length) {
      errors.push(`${method.id}: no test consumes implementation`);
      continue;
    }
    for (const file of method.implementation)
      if (!evidence.files.has(file))
        errors.push(`${method.id}: declared implementation missing: ${file}`);
    if (method.review !== "reviewed") {
      errors.push(`${method.id}: semantic review required before completion`);
      continue;
    }
    const before = {
      status: method.status,
      implementation: method.implementation,
      tests: method.tests,
    };
    method.status = bindings.completion;
    method.implementation = [...new Set([...method.implementation, ...owners])];
    method.tests = [...new Set([...method.tests, ...discovered.sort()])];
    const after = {
      status: method.status,
      implementation: method.implementation,
      tests: method.tests,
    };
    if (JSON.stringify(before) !== JSON.stringify(after))
      changes.push({ id: method.id, before, after });
  }
  for (const id of evidence.owners.keys())
    if (!bound.has(id) && !legacyPresetBoundaries[id])
      errors.push(`registered preset missing from method map: ${id}`);
  return {
    map: next,
    errors,
    changes,
    pendingWithoutEvidence: next.methods
      .filter((m) => m.status === "planned" && !m.bindings)
      .map((m) => m.id),
  };
}
