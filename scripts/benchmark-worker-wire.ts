import { Worker } from "node:worker_threads";
import { deserialize } from "node:v8";
import { performance } from "node:perf_hooks";
import { screenLocal } from "../src/server/screening";
import { get } from "../src/server/db";
import { defaultStrategy, type Coverage } from "../src/lib/domain";

const coverage = get<Coverage>("coverage");
if (!coverage) throw new Error("请先扫描本地覆盖目录");
const result = await screenLocal({
  root: coverage.root,
  period: "5m",
  symbols: coverage.securities
    .filter((entry) => entry.period === "5m")
    .map((entry) => entry.symbol),
  strategy: defaultStrategy,
});
const worker = new Worker(
  `
const {parentPort}=require('node:worker_threads');
const {serialize}=require('node:v8');
let result;
parentPort.on('message',message=>{
  if(message.result){result=message.result;parentPort.postMessage({ready:true});return;}
  if(message.mode==='object') parentPort.postMessage({result});
  else {const payload=Uint8Array.from(serialize(result));parentPort.postMessage({payload},[payload.buffer]);}
});`,
  { eval: true },
);
function request(
  message: unknown,
): Promise<{ result?: unknown; payload?: Uint8Array }> {
  return new Promise<{ result?: unknown; payload?: Uint8Array }>(
    (resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.postMessage(message);
    },
  ).finally(() => worker.removeAllListeners("error"));
}
try {
  await request({ result });
  const expected = JSON.stringify(result);
  for (let round = 1; round <= 5; round++) {
    for (const mode of ["object", "binary"]) {
      const started = performance.now();
      const reply = await request({ mode });
      const restored = reply.payload
        ? deserialize(reply.payload)
        : reply.result;
      const ms = Math.round(performance.now() - started);
      if (JSON.stringify(restored) !== expected)
        throw new Error("传输改变结果");
      console.log(
        JSON.stringify({
          round,
          mode,
          ms,
          candidates: result.candidates.length,
          bytes: mode === "binary" ? reply.payload?.byteLength : undefined,
          consistent: true,
        }),
      );
    }
  }
} finally {
  await worker.terminate();
}
