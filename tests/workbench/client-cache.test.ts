import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import type { Snapshot } from "../../src/lib/domain";
import {
  snapshotCacheKey,
  useSnapshotCache,
} from "../../src/lib/stores/snapshot-cache";
import {
  applyCachePolicy,
  PERSIST_MAX_AGE,
  shouldPersistQuery,
} from "../../src/trpc/cache-policy";

const snap = (id: string) => ({ id }) as Snapshot;

it("快照缓存按最近使用淘汰，最多 12 条", () => {
  const cache = useSnapshotCache.getState();
  cache.clear();
  for (let i = 0; i < 13; i++) cache.put(`k${i}`, snap(`s${i}`));
  cache.put("k1", snap("s1b"));
  cache.put("k13", snap("s13"));
  const keys = [...useSnapshotCache.getState().entries.keys()];
  expect(keys).toHaveLength(12);
  expect(keys).not.toContain("k0");
  expect(keys).not.toContain("k2");
  expect(keys.at(-2)).toBe("k1");
  expect(useSnapshotCache.getState().get("k1")?.id).toBe("s1b");
  expect(snapshotCacheKey({ symbol: "sh600519", period: "day" })).toBe("sh600519|day||");
});

it("只持久化白名单内且成功的查询；实时与任务状态不持久化", () => {
  const client = new QueryClient();
  applyCachePolicy(client);
  const query = (name: string, status: "success" | "error" = "success") => {
    const key = [[name], { input: "sh600519", type: "query" }];
    client.setQueryData(key, { ok: true });
    const q = client.getQueryCache().find({ queryKey: key, exact: true })!;
    if (status === "error") q.setState({ status: "error" });
    return q;
  };
  expect(shouldPersistQuery(query("securityNames"))).toBe(true);
  expect(shouldPersistQuery(query("stockEvents"))).toBe(true);
  expect(shouldPersistQuery(query("tdxQuotes"))).toBe(false);
  expect(shouldPersistQuery(query("jobs"))).toBe(false);
  expect(shouldPersistQuery(query("binanceCredentialStatus"))).toBe(false);
  expect(shouldPersistQuery(query("macroRates", "error"))).toBe(false);
  const defaults = client.getQueryDefaults([["securityNames"], { type: "query" }]);
  expect(defaults.staleTime).toBe(3600000);
  expect(defaults.gcTime).toBe(PERSIST_MAX_AGE);
  expect(client.getQueryDefaults([["jobs"], {}]).gcTime).toBeUndefined();
});
