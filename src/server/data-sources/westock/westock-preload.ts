import { westockUnadjustedRequest } from "./westock-unadjusted";

// Loaded only in a dedicated CLI child, never in the app or shared worker.
if (
  process.argv[2] === "kline" &&
  process.argv[process.argv.indexOf("--fq") + 1] === "bfq"
) {
  const upstream = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    upstream(input, westockUnadjustedRequest(input, init));
}
