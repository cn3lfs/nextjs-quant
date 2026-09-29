import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { startPersisting } from "../../src/trpc/persist";
import { applyCachePolicy } from "../../src/trpc/cache-policy";

afterEach(() => vi.useRealTimers());

it("saves only when a persisted query gets new data, throttled", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  applyCachePolicy(client);
  const persistClient = vi.fn();
  const stop = startPersisting(
    client,
    {
      persistClient,
      restoreClient: async () => undefined,
      removeClient: async () => {},
    },
    "test",
  );
  // A polled, non-persisted query (e.g. deliveries) never triggers a save.
  for (let i = 0; i < 5; i++)
    await client.fetchQuery({
      queryKey: [["deliveries"], { type: "query" }],
      queryFn: () => [i],
      staleTime: 0,
    });
  await vi.advanceTimersByTimeAsync(5000);
  expect(persistClient).not.toHaveBeenCalled();
  // Persisted data (security directory) saves once per throttle window.
  await client.fetchQuery({
    queryKey: [["securityNames"], { type: "query" }],
    queryFn: () => ({ sh600000: "浦发银行" }),
  });
  client.setQueryData([["chartView"], { type: "query" }], { dark: true });
  await vi.advanceTimersByTimeAsync(2000);
  expect(persistClient).toHaveBeenCalledTimes(1);
  const saved = persistClient.mock.calls[0]![0].clientState.queries.map(
    (q: { queryKey: [[string]] }) => q.queryKey[0][0],
  );
  expect(saved.sort()).toEqual(["chartView", "securityNames"]);
  stop();
});
