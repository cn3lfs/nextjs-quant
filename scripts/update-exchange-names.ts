import { writeFile } from "node:fs/promises";
import { z } from "zod";
import snapshot from "../src/server/data/exchange-delisted.json";
import { exchangeNamesSchema } from "../src/server/exchange-security-names";

// Rebuild the offline identity fallback from the exchanges, never from LLM names.
async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: {
      Referer: new URL(url).hostname.includes("sse.com")
        ? "https://www.sse.com.cn/"
        : "https://www.szse.cn/",
      "User-Agent": "Mozilla/5.0",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Exchange HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}
const sh = z
  .object({
    result: z
      .array(
        z.object({
          STOCK_TYPE: z.string(),
          A_STOCK_CODE: z.string(),
          COMPANY_ABBR: z.string(),
          LIST_DATE: z.string(),
          DELIST_DATE: z.string(),
        }),
      )
      .min(1),
  })
  .parse(await fetchJson(snapshot.sources.sse));
const entries = sh.result
  .filter((row) => ["1", "8"].includes(row.STOCK_TYPE))
  .map((row) => ({
    symbol: `sh${row.A_STOCK_CODE}`,
    name: row.COMPANY_ABBR,
    listingDate: row.LIST_DATE,
    delistingDate: row.DELIST_DATE,
    source: "sse",
  }));
let records = 0;
for (let page = 1; page <= 100; page++) {
  const tabs = z
    .array(
      z.object({
        metadata: z.object({
          tabkey: z.string(),
          pagecount: z.number().int().min(0).max(100),
          recordcount: z.number().int().nonnegative(),
          pageno: z.number().int(),
        }),
        data: z.array(z.record(z.string())),
      }),
    )
    .parse(await fetchJson(`${snapshot.sources.szse}&PAGENO=${page}`));
  const tab = tabs.find((tab) => tab.metadata.tabkey === "tab2");
  if (!tab || tab.metadata.pageno !== page)
    throw new Error("SZSE pagination mismatch");
  records += tab.data.length;
  entries.push(
    ...tab.data
      .filter((row) => /^(00|30)\d{4}$/.test(row.zqdm ?? ""))
      .map((row) => ({
        symbol: `sz${row.zqdm}`,
        name: row.zqjc!,
        listingDate: row.ssrq!,
        delistingDate: row.zzrq!,
        source: "szse",
      })),
  );
  if (page >= tab.metadata.pagecount) {
    if (records !== tab.metadata.recordcount)
      throw new Error("SZSE incomplete result");
    break;
  }
}
const next = exchangeNamesSchema.parse({
  version: 1,
  fetchedAt: new Date().toISOString(),
  sources: snapshot.sources,
  entries,
});
await writeFile(
  "src/server/data/exchange-delisted.json",
  JSON.stringify(next, null, 2) + "\n",
);
console.info(`Updated ${next.entries.length} official historical identities`);
