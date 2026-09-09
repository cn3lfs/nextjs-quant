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
      const { high, low, close, volume } = czscInput(message.input);
      const n = high.length,
        registered = new Float32Array(n);
      if (n) func40(n, registered, close, volume, new Float32Array([0]));
      const projections: Record<string, number[]> = {};
      for (const config of message.configs) {
        if (![0, 1100].includes(config))
          throw new RangeError("Unsupported CZSC config");
        for (const output of message.outputs) {
          if (!Number.isInteger(output) || output < 0 || output > 58)
            throw new RangeError("Invalid CZSC output");
          const out = new Float32Array(n);
          if (n)
            func30(
              n,
              out,
              high,
              low,
              new Float32Array([config * 1000 + output * 10]),
            );
          projections[`${config}:${output}`] = Array.from(out);
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
