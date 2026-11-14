import { readFile, writeFile } from "node:fs/promises";
import { methodStrategyBindings } from "trading-strategies";
import { tradingMethodMapSchema } from "./lib/trading-method-map";

const file = "docs/trading-skills-method-map.json";
const map = tradingMethodMapSchema.parse(
  JSON.parse(await readFile(file, "utf8")),
);
for (const method of map.methods) {
  const binding =
    methodStrategyBindings[method.id as keyof typeof methodStrategyBindings];
  method.execution = binding
    ? {
        status: "runnable",
        rule: binding.rule,
        variant: binding.variant,
        reason: binding.reason,
      }
    : {
        status: "reference",
        reason:
          "规则库保留；尚无该方法精确版本到统一策略对象的绑定，不以已有研究函数冒充转换完成",
      };
}
const counts = {
  total: map.methods.length,
  runnable: map.methods.filter((m) => m.execution?.status === "runnable")
    .length,
  reference: map.methods.filter((m) => m.execution?.status === "reference")
    .length,
};
if (process.argv.includes("--write"))
  await writeFile(file, `${JSON.stringify(map, null, 2)}\n`);
console.log(JSON.stringify(counts));
