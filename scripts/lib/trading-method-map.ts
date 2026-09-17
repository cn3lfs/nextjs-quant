import { z } from "zod";
import type { SkillInventory } from "./trading-skill-inventory";

const path = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !value.includes(":") &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "必须使用仓库或技能根内的相对路径",
  );
const delivery = z
  .object({
    implementation: z
      .object({
        status: z.enum(["complete", "engineering", "planned"]),
        note: z.string().min(1),
      })
      .strict(),
    data: z
      .object({
        status: z.enum(["available", "partial", "missing", "unknown"]),
        note: z.string().min(1),
      })
      .strict(),
    realBacktest: z
      .object({
        status: z.enum(["complete", "pending"]),
        resultRecords: z.array(z.string()),
        note: z.string().min(1),
      })
      .strict(),
    effect: z
      .object({
        status: z.enum(["concluded", "pending"]),
        note: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export const tradingMethodMapSchema = z
  .object({
    version: z.literal("trading-method-map-1"),
    methods: z.array(
      z
        .object({
          id: z.string().regex(/^[A-Z][A-Za-z0-9-]+$/),
          title: z.string().min(1),
          batch: z.string().regex(/^K\d+[ab]?$/),
          sources: z.array(path).min(1),
          review: z.enum(["pending", "reviewed"]),
          status: z.enum(["planned", "implemented-variant", "implemented"]),
          implementation: z.array(path),
          tests: z.array(path),
          boundary: z.string().min(1),
          delivery: delivery.optional(),
          bindings: z
            .object({
              presets: z.array(z.string()).default([]),
              exports: z
                .array(
                  z.object({ file: path, name: z.string().min(1) }).strict(),
                )
                .default([]),
              completion: z.enum(["implemented", "implemented-variant"]),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    dispositions: z.array(
      z
        .object({
          source: path,
          kind: z.enum([
            "methods",
            "input",
            "implementation-reference",
            "non-trading",
          ]),
          methodIds: z.array(z.string()),
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export function auditTradingMethodMap(
  raw: unknown,
  inventory: SkillInventory,
  repositoryFiles: ReadonlySet<string>,
) {
  const map = tradingMethodMapSchema.parse(raw);
  const summarize = (methods: typeof map.methods) => ({
    planned: methods.filter((method) => method.status === "planned").length,
    variants: methods.filter(
      (method) => method.status === "implemented-variant",
    ).length,
    implemented: methods.filter((method) => method.status === "implemented")
      .length,
    pendingIds: methods
      .filter((method) => method.status === "planned")
      .map((method) => method.id),
  });
  const sources = new Set(
    inventory.skills.flatMap((skill) =>
      skill.sources.map((source) => `${skill.id}/${source.path}`),
    ),
  );
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const method of map.methods) {
    if (ids.has(method.id)) errors.push(`重复方法ID：${method.id}`);
    ids.add(method.id);
    if (!method.delivery) {
      errors.push(`${method.id}缺四列交付状态`);
    } else {
      const expectedImplementation =
        method.status === "implemented"
          ? "complete"
          : method.status === "implemented-variant"
            ? "engineering"
            : "planned";
      if (method.delivery.implementation.status !== expectedImplementation)
        errors.push(`${method.id}实现状态与四列不一致`);
      if (
        method.delivery.realBacktest.status === "complete" &&
        method.delivery.realBacktest.resultRecords.length === 0
      )
        errors.push(`${method.id}标了真实回测完成但没有结果记录`);
      if (
        method.delivery.realBacktest.status === "pending" &&
        method.delivery.realBacktest.resultRecords.length > 0
      )
        errors.push(`${method.id}真实回测待完成却已有结果记录`);
      if (
        method.delivery.effect.status === "concluded" &&
        method.delivery.realBacktest.status !== "complete"
      )
        errors.push(`${method.id}效果结论先于真实回测完成`);
    }
    for (const source of method.sources)
      if (!sources.has(source))
        errors.push(`${method.id}来源未锁定：${source}`);
    if (
      method.status !== "planned" &&
      (method.review !== "reviewed" ||
        !method.implementation.length ||
        !method.tests.length)
    )
      errors.push(`${method.id}实现声明缺少语义复核、代码或验证入口`);
    for (const file of [...method.implementation, ...method.tests])
      if (!repositoryFiles.has(file))
        errors.push(`${method.id}仓库引用不存在：${file}`);
  }
  const disposed = new Set<string>();
  for (const disposition of map.dispositions) {
    if (!sources.has(disposition.source))
      errors.push(`处置来源未锁定：${disposition.source}`);
    if (disposed.has(disposition.source))
      errors.push(`重复来源处置：${disposition.source}`);
    disposed.add(disposition.source);
    for (const method of map.methods) {
      if (
        method.review === "reviewed" &&
        method.sources.includes(disposition.source) &&
        (disposition.kind !== "methods" ||
          !disposition.methodIds.includes(method.id))
      )
        errors.push(
          `整文件处置遗漏已复核方法：${disposition.source} -> ${method.id}`,
        );
    }
    if (disposition.kind === "methods" && !disposition.methodIds.length)
      errors.push(`方法来源缺少对应ID：${disposition.source}`);
    for (const id of disposition.methodIds) {
      const method = map.methods.find((row) => row.id === id);
      if (
        !method ||
        !method.sources.includes(disposition.source) ||
        method.review !== "reviewed"
      )
        errors.push(
          `处置引用未复核或未对应来源：${disposition.source} -> ${id}`,
        );
    }
  }
  return {
    errors,
    counts: {
      methods: map.methods.length,
      implemented: map.methods.filter((m) => m.status === "implemented").length,
      variants: map.methods.filter((m) => m.status === "implemented-variant")
        .length,
    },
    delivery: {
      implementation: Object.fromEntries(
        ["complete", "engineering", "planned"].map((status) => [
          status,
          map.methods.filter(
            (m) => m.delivery?.implementation.status === status,
          ).length,
        ]),
      ),
      data: Object.fromEntries(
        ["available", "partial", "missing", "unknown"].map((status) => [
          status,
          map.methods.filter((m) => m.delivery?.data.status === status).length,
        ]),
      ),
      realBacktest: Object.fromEntries(
        ["complete", "pending"].map((status) => [
          status,
          map.methods.filter((m) => m.delivery?.realBacktest.status === status)
            .length,
        ]),
      ),
      effect: Object.fromEntries(
        ["concluded", "pending"].map((status) => [
          status,
          map.methods.filter((m) => m.delivery?.effect.status === status)
            .length,
        ]),
      ),
    },
    batches: Object.fromEntries(
      [...new Set(map.methods.map((method) => method.batch))]
        .sort()
        .map((batch) => {
          const methods = map.methods.filter(
            (method) => method.batch === batch,
          );
          return [batch, summarize(methods)];
        }),
    ),
    deliveryBatches: {
      B1: summarize(
        map.methods.filter((method) => ["K3", "K4"].includes(method.batch)),
      ),
    },
    pendingMethods: map.methods
      .filter((m) => m.review === "pending" || m.status !== "implemented")
      .map((m) => m.id),
    undisposedSources: [...sources]
      .filter((source) => !disposed.has(source))
      .sort(),
  };
}
