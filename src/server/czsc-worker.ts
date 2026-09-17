import koffi from "koffi";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { czscInput, type CzscInput } from "./czsc-input";

const dllPath = resolve("runtime/czsc/CZSC64.dll");
const hash = createHash("sha256").update(readFileSync(dllPath)).digest("hex");
const library = koffi.load(dllPath);
// FxIndicator.h uses #pragma pack(push,1): ushort + pointer, 10 bytes on x64.
const entry = koffi.pack({ mark: "uint16", call: "void *" });
const register = library.func("int RegisterTdxFunc(_Out_ void **table)");
const table = [null];
if (!register(table) || !table[0]) throw new Error("CZSC registration failed");
const proto = koffi.proto(
  "void CzscCalc(int n, float *out, float *a, float *b, float *c)",
);
const pointers = new Map<number, unknown>();
for (let i = 0; i < 64; i++) {
  const item = koffi.decode(table[0], i * koffi.sizeof(entry), entry) as {
    mark: number;
    call: unknown;
  };
  if (item.mark === 0) break;
  pointers.set(item.mark, item.call);
}
const func30 = koffi.decode(pointers.get(30), proto) as (
  n: number,
  out: Float32Array,
  a: Float32Array,
  b: Float32Array,
  c: Float32Array,
) => void;
const func40 = koffi.decode(pointers.get(40), proto) as typeof func30;

// Synchronous IPC handler: Func40 and every projection form one indivisible job.
// Never use koffi's .async or worker_threads for this stateful DLL.
process.on(
  "message",
  (message: {
    id: number;
    input: CzscInput;
    configs: number[];
    outputs: number[];
  }) => {
    try {
      if (message.outputs.some((o) => !Number.isInteger(o) || o < 0 || o > 99))
        throw new RangeError("Invalid CZSC output");
      const { high, low, close, volume } = czscInput(message.input);
      if (high.length > 16777216)
        throw new RangeError("CZSC input exceeds exact index domain");
      const n = high.length,
        registered = new Float32Array(n);
      if (n) func40(n, registered, close, volume, new Float32Array([0]));
      const projections: Record<string, number[]> = {};
      // All counts and slots remain inside this synchronous IPC transaction.
      const run = (config: number, output: number, slot = 0) => {
        const out = new Float32Array(n);
        const mode = new Float32Array(output >= 59 && output <= 91 ? n : 1);
        mode[0] = config * 1000 + output * 10;
        if (output >= 59 && output <= 91 && n > 1) mode[1] = slot;
        if (n) func30(n, out, high, low, mode);
        return Array.from(out);
      };
      for (const config of message.configs) {
        if (![0, 1100].includes(config))
          throw new RangeError("Unsupported CZSC config");
        const counts = new Map<number, number[]>();
        if (message.outputs.some((o) => o >= 93)) {
          const dates = message.input.dates,
            anchor = message.input.anchor;
          if (!dates || dates.length !== n || ![1, 2].includes(anchor ?? 0))
            throw new Error("显式锚及逐根日期缺失");
          const dateCodes = dates.map((date, i) => {
            if (anchor === 2) {
              if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(date))
                throw new Error("五分钟锚必须使用已结束五分钟K线的上海时戳");
              const minute =
                Number(date.slice(11, 13)) * 60 + Number(date.slice(14, 16));
              if (
                minute % 5 ||
                !(
                  (minute >= 575 && minute <= 690) ||
                  (minute >= 785 && minute <= 900)
                )
              )
                throw new Error("五分钟收盘时戳不在交易时段");
            }
            const day = date.slice(0, 10);
            if (
              !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
              !Number.isFinite(Date.parse(date)) ||
              new Date(day).toISOString().slice(0, 10) !== day ||
              (i > 0 && date <= dates[i - 1]!) ||
              (anchor === 1 && date !== day) ||
              (anchor === 2 &&
                (!/T\d{2}:\d{2}/.test(date) ||
                  day < "2000-01-04" ||
                  day > "2022-11-30"))
            )
              throw new Error("锚周期、日期顺序或五分钟窗口无效");
            return Number(day.replaceAll("-", "")) - 20000000;
          });
          const explicit = (output: number, slot = 0, field = 0) => {
            const mode = Float32Array.from([
              config * 1000 + output * 10,
              slot,
              field,
              anchor!,
              ...dateCodes,
            ]);
            const out = new Float32Array(n);
            if (n) func30(n, out, high, low, mode);
            const values = Array.from(out);
            projections[`${config}:${output}:${slot}:${field}`] = values;
            if (!slot && !field) projections[`${config}:${output}`] = values;
            return values.at(-1) ?? 0;
          };
          if (n && explicit(93) !== 1) throw new Error("原生显式锚不可用");
          for (const [countOutput, rowOutput, fields] of [
            [94, 95, 17],
            [96, 97, 15],
            [98, 99, 8],
          ]) {
            const count = explicit(countOutput!);
            if (!Number.isInteger(count) || count < 0 || count > 16777216)
              throw new Error("原生旁路行数非法");
            for (let slot = 0; slot < count; slot++) {
              for (let field = 0; field < fields!; field++)
                explicit(rowOutput!, slot, field);
              if (rowOutput === 95) {
                const children =
                  projections[`${config}:95:${slot}:10`]!.at(-1)!;
                if (
                  !Number.isInteger(children) ||
                  children < 0 ||
                  children > count
                )
                  throw new Error("原生子成员数非法");
                for (let j = 0; j < children; j++) explicit(95, slot, 100 + j);
              }
            }
          }
        }
        for (const output of message.outputs) {
          if (output >= 93) continue;
          if (!Number.isInteger(output) || output < 0 || output > 99)
            throw new RangeError("Invalid CZSC output");
          if (output < 59 || output === 92) {
            projections[`${config}:${output}`] = run(config, output);
            continue;
          }
          const countOutput = output < 70 ? 59 : 70;
          if (!counts.has(countOutput)) {
            const values = run(config, countOutput);
            if (
              values.some((v) => !Number.isInteger(v) || v < 0 || v > 16777216)
            )
              throw new Error("结构缺口：原生投影行数非法");
            counts.set(countOutput, values);
            projections[`${config}:${countOutput}`] = values;
          }
          if (output === countOutput) continue;
          const max = counts
            .get(countOutput)!
            .reduce((a, b) => Math.max(a, b), 0);
          for (let slot = 0; slot < Math.max(1, max); slot++) {
            const values = run(config, output, slot);
            projections[`${config}:${output}:${slot}`] = values;
            if (slot === 0) projections[`${config}:${output}`] = values;
          }
        }
      }
      process.send?.({
        id: message.id,
        result: { hash, registered: Array.from(registered), projections },
      });
    } catch (error) {
      process.send?.({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
// Decoded registration-table pointers do not retain their owning library.
// Keep it reachable for the entire worker lifetime; otherwise GC can unload the
// DLL between jobs (koffi/doc/load.md), leaving func30/func40 dangling.
process.on("disconnect", () => {
  library.unload();
  process.exit(0);
});
