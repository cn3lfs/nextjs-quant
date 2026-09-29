"use client";
import {
  IsRestoringProvider,
  QueryClientProvider,
  type QueryCacheNotifyEvent,
  type QueryClient,
} from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  type Persister,
} from "@tanstack/react-query-persist-client";
import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PERSIST_MAX_AGE, shouldPersistQuery } from "./cache-policy";

/** Whether a cache event means a persisted query received new data. */
export function isPersistedDataChange(event: QueryCacheNotifyEvent) {
  return (
    (event.type === "added" ||
      event.type === "removed" ||
      (event.type === "updated" && event.action.type === "success")) &&
    shouldPersistQuery(event.query)
  );
}

/**
 * The stock persist provider saves on every query-cache event: each poll of
 * any query (deliveries every 4 s, monitors, signals…) dehydrated and
 * SuperJSON-serialized the whole persisted set, security directory included,
 * keeping an idle page busy. Save only when a persisted query's data actually
 * changed, throttled; start after the restore so it cannot overwrite the
 * stored cache with an empty one.
 */
export function startPersisting(
  queryClient: QueryClient,
  persister: Persister,
  buster: string,
  throttleMs = 2000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    timer = undefined;
    void persistQueryClientSave({
      queryClient,
      persister,
      buster,
      dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
    });
  };
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (timer === undefined && isPersistedDataChange(event))
      timer = setTimeout(save, throttleMs);
  });
  return () => {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * Same contract as `PersistQueryClientProvider` (restore once, expose
 * `useIsRestoring` until done) but saving through `startPersisting` instead
 * of the stock every-event subscription, which dehydrates — and so
 * SuperJSON-serializes — the persisted set on each poll of any query.
 */
export function PersistProvider({
  client,
  persister,
  buster,
  children,
}: {
  client: QueryClient;
  persister: Persister | null;
  buster: string;
  children: ReactNode;
}) {
  // Starts restoring on the server and the client alike, like the stock
  // provider: a server/client difference here changes every query's first
  // render (fetching vs idle) and breaks hydration.
  const [restoring, setRestoring] = useState(true);
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (!persister) {
      setRestoring(false);
      return;
    }
    void persistQueryClientRestore({
      queryClient: client,
      persister,
      maxAge: PERSIST_MAX_AGE,
      buster,
    })
      .catch(() => {})
      .finally(() => setRestoring(false));
  }, [client, persister, buster]);
  useEffect(
    () =>
      persister && !restoring
        ? startPersisting(client, persister, buster)
        : undefined,
    [client, persister, buster, restoring],
  );
  return createElement(QueryClientProvider, {
    client,
    children: createElement(IsRestoringProvider, {
      value: restoring,
      children,
    }),
  });
}
