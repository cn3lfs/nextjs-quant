import { expect, it } from "vitest";
import { TdxSession } from "../../../src/server/data-sources/tdx/tdx-quotes";
import {
  buildBarsRequest,
  parseBars,
} from "../../../src/server/data-sources/tdx/tdx-wire";

it.skipIf(!process.env.QUANT_TDX_INDEX_AUDIT)(
  "reads index bars directly from TDX",
  async () => {
    const session = await TdxSession.connect(
      process.env.QUANT_TDX_INDEX_HOST ?? "180.153.18.170",
      7709,
      3000,
    );
    try {
      const started = Date.now();
      const body = await session.request(
        buildBarsRequest("sh000001", "day", 0, 10),
      );
      console.info({
        bytes: body.length,
        count: body.readUInt16LE(0),
        elapsedMs: Date.now() - started,
      });
      const bars = parseBars(body, "day", true);
      expect(bars).toHaveLength(10);
    } finally {
      await session.close();
    }
  },
  10000,
);
