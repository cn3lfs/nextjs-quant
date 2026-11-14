"use client";
import { useRef, useState } from "react";
import type { Snapshot } from "~/lib/domain";
import {
  snapshotCacheKey,
  useSnapshotCache,
  type SnapshotRequest,
} from "~/lib/stores/snapshot-cache";
import { api, type RouterInputs } from "~/trpc/react";
import { isCryptoSymbol } from "~/lib/market/crypto";
import { isFuturesSymbol } from "~/lib/market/futures";

type Input = RouterInputs["snapshot"];

/**
 * `api.snapshot.useMutation` with stale-while-revalidate: a snapshot viewed
 * earlier in this session is shown at once, the server is still asked, and
 * the result replaces it only when its content id differs. Pass
 * `{ fresh: true }` for an explicit refresh that should show loading.
 */
export function useSnapshotLoad(
  options: {
    onSuccess?: (snapshot: Snapshot) => void;
    onError?: (error: { message: string }) => void;
  } = {},
) {
  const mutation = api.snapshot.useMutation();
  const selection = useRef(0);
  // True from showing a cached snapshot until the next cold request, so a
  // failed revalidation neither shows loading nor replaces the chart.
  const [servedFromCache, setServedFromCache] = useState(false);
  const mutate = (input: Input, call: { fresh?: boolean } = {}) => {
    const request = ++selection.current;
    // Read the store imperatively; subscribing would re-render on every put.
    const cache = useSnapshotCache.getState();
    const generation = cache.generation;
    const marketGeneration =
      isCryptoSymbol(input.symbol) || isFuturesSymbol(input.symbol)
        ? null
        : cache.marketGeneration;
    const isCurrent = () => {
      const current = useSnapshotCache.getState();
      return (
        selection.current === request &&
        current.generation === generation &&
        (marketGeneration === null ||
          current.marketGeneration === marketGeneration)
      );
    };
    const key = snapshotCacheKey(input as SnapshotRequest);
    const hit = call.fresh ? undefined : cache.get(key);
    if (hit) options.onSuccess?.(hit);
    setServedFromCache(!!hit);
    mutation.mutate(input, {
      onSuccess: (snapshot) => {
        if (!isCurrent()) return;
        useSnapshotCache.getState().put(key, snapshot);
        if (hit?.id !== snapshot.id) options.onSuccess?.(snapshot);
      },
      onError: (error) => {
        if (!isCurrent()) return;
        // The cached chart stays up; only a cold load reports the failure.
        if (!hit) options.onError?.(error);
      },
    });
  };
  return {
    mutate,
    /** Selecting a saved candidate replaces the previous request and its error.
     * It is not a cache refresh: retain the candidate's recorded snapshot. */
    acceptSnapshot: (snapshot: Snapshot) => {
      selection.current++;
      mutation.reset();
      setServedFromCache(false);
      options.onSuccess?.(snapshot);
    },
    isPending: mutation.isPending && !servedFromCache,
    /** A cached snapshot is shown while the server confirms it. */
    isRevalidating: mutation.isPending && servedFromCache,
    error: servedFromCache ? null : mutation.error,
  };
}
