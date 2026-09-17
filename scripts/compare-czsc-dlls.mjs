import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
export const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/czsc-sse.json", import.meta.url),
);
export const configs = [0, 1100];
export const tolerance = 0.0001;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function readFixture() {
  const bytes = readFileSync(fixturePath);
  const fixture = JSON.parse(bytes);
  if (
    fixture.date.length !== 2038 ||
    fixture.date[0] !== "2018-01-26" ||
    fixture.date.at(-1) !== "2026-06-26"
  )
    throw new Error("Expected the fixed 2038-bar SSE daily fixture");
  for (const field of ["high", "low", "close", "volume"]) {
    if (
      fixture[field].length !== 2038 ||
      !fixture[field].every(Number.isFinite)
    )
      throw new Error(`Invalid fixture ${field}`);
  }
  return { fixture, fixtureSha256: sha256(bytes) };
}

// Both values must already be float32. Subtraction/comparison intentionally uses
// JS doubles, like tests/czsc.test.ts: absolute difference STRICTLY < 0.0001.
export function compareSeries(before, after, onDifference = () => {}) {
  if (before.length !== after.length)
    throw new Error("Projection length mismatch");
  let differences = 0,
    nonIdentical = 0;
  for (let index = 0; index < before.length; index++) {
    const oldValue = before[index],
      newValue = after[index];
    if (!Object.is(oldValue, newValue)) nonIdentical++;
    const delta = Math.abs(oldValue - newValue);
    if (
      !Number.isFinite(oldValue) ||
      !Number.isFinite(newValue) ||
      !(delta < tolerance)
    ) {
      differences++;
      onDifference({ index, oldValue, newValue, delta });
    }
  }
  return { differences, nonIdentical };
}

async function snapshot(dllPath) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error(
      "Run with Windows x64 Node.js (the inputs are Windows x64 DLLs)",
    );
  const { default: koffi } = await import("koffi");
  const { fixture, fixtureSha256 } = readFixture();
  const dllSha256 = sha256(readFileSync(dllPath));
  const library = koffi.load(dllPath);
  try {
    const entry = koffi.pack({ mark: "uint16", call: "void *" });
    const register = library.func("int RegisterTdxFunc(_Out_ void **table)");
    const table = [null];
    if (!register(table) || !table[0]) throw new Error("Registration failed");
    const proto = koffi.proto(
      "void CompareCzscCalc(int n, float *out, float *a, float *b, float *c)",
    );
    const pointers = new Map();
    for (let i = 0; i < 64; i++) {
      const item = koffi.decode(table[0], i * koffi.sizeof(entry), entry);
      if (item.mark === 0) break;
      pointers.set(item.mark, item.call);
    }
    if (!pointers.get(30) || !pointers.get(40))
      throw new Error("Missing Func30/40");
    const func30 = koffi.decode(pointers.get(30), proto);
    const func40 = koffi.decode(pointers.get(40), proto);
    const high = Float32Array.from(fixture.high),
      low = Float32Array.from(fixture.low);
    const close = Float32Array.from(fixture.close),
      volume = Float32Array.from(fixture.volume);
    const n = high.length,
      projections = {};
    // Separate processes per DLL; every call is synchronous. Cover both legacy
    // H/L-only fallback and real registered C/V, in both supported app configs.
    for (const aux of [false, true]) {
      func40(0, null, null, null, null);
      if (aux)
        func40(n, new Float32Array(n), close, volume, new Float32Array([0]));
      for (const config of configs) {
        for (let output = 0; output <= 58; output++) {
          const out = new Float32Array(n).fill(NaN);
          func30(
            n,
            out,
            high,
            low,
            new Float32Array([config * 1000 + output * 10]),
          );
          if (!out.every(Number.isFinite))
            throw new Error(
              `Non-finite output aux=${aux} config=${config} output=${output}`,
            );
          projections[`${aux ? "cv" : "hl"}:${config}:${output}`] =
            Array.from(out);
        }
      }
    }
    return { dllSha256, fixtureSha256, projections };
  } finally {
    library.unload();
  }
}

function childSnapshot(path) {
  const result = spawnSync(
    process.execPath,
    [script, "--snapshot", resolve(path)],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `DLL snapshot failed (${path}): ${result.error?.message ?? result.stderr ?? result.signal}`,
    );
  return JSON.parse(result.stdout);
}

export function compareSnapshots(
  before,
  after,
  fixture,
  onDifference = () => {},
) {
  if (before.fixtureSha256 !== after.fixtureSha256)
    throw new Error("Fixture changed between DLL runs");
  let differences = 0,
    nonIdentical = 0,
    compared = 0,
    firstDifference = null;
  for (const aux of ["hl", "cv"])
    for (const config of configs)
      for (let output = 0; output <= 58; output++) {
        const key = `${aux}:${config}:${output}`;
        const a = before.projections[key],
          b = after.projections[key];
        if (
          !a ||
          !b ||
          a.length !== fixture.date.length ||
          b.length !== fixture.date.length
        )
          throw new Error(`Missing or truncated projection ${key}`);
        const result = compareSeries(a, b, (difference) => {
          const item = {
            aux,
            config,
            output,
            ...difference,
            date: fixture.date[difference.index],
          };
          firstDifference ??= item;
          onDifference(item);
        });
        differences += result.differences;
        nonIdentical += result.nonIdentical;
        compared += a.length;
      }
  return {
    compared,
    differences,
    nonIdentical,
    firstDifference,
    exitCode: differences ? 1 : 0,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--snapshot" && args.length === 2) {
    console.log(JSON.stringify(await snapshot(resolve(args[1]))));
    return;
  }
  if (args.length !== 2)
    throw new Error(
      "Usage: node scripts/compare-czsc-dlls.mjs <old.dll> <new.dll>",
    );
  const before = childSnapshot(args[0]);
  const after = childSnapshot(args[1]);
  const { fixture, fixtureSha256 } = readFixture();
  if (fixtureSha256 !== before.fixtureSha256)
    throw new Error("Fixture changed during comparison");
  const result = compareSnapshots(before, after, fixture, (item) =>
    console.log(`DIFF ${JSON.stringify(item)}`),
  );
  console.log(
    JSON.stringify(
      {
        oldDll: resolve(args[0]),
        newDll: resolve(args[1]),
        oldSha256: before.dllSha256,
        newSha256: after.dllSha256,
        fixture: fixturePath,
        fixtureSha256,
        tolerance,
        strictLessThan: true,
        ...result,
        conclusion: result.exitCode
          ? "FAIL"
          : "PASS: all 0-58 outputs match within tolerance",
      },
      null,
      2,
    ),
  );
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
