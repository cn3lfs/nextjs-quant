import { expect, it } from "vitest";
import { keyedSlots } from "../src/server/infra/keyed-slots";

it("cancellation releases partial claims and later callers can reuse all keys", async () => {
  const claim = keyedSlots();
  const releaseB = await claim(["b"]);
  const abort = new AbortController();
  const waiting = claim(["b", "a", "a"], abort.signal);
  const rejected = expect(waiting).rejects.toThrow();
  abort.abort();
  await rejected;
  const releaseA = await claim(["a"]);
  releaseA();
  releaseA();
  releaseB();
  const releaseAll = await claim(["b", "a"]);
  releaseAll();
});
