"use client";

import { type QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { createStore, del, get, set } from "idb-keyval";
import { httpBatchStreamLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { type inferRouterInputs, type inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import SuperJSON from "superjson";

import type { AppRouter } from "~/server/api/root";
import { createQueryClient } from "./query-client";
import { applyCachePolicy } from "./cache-policy";
import { PersistProvider } from "./persist";

let clientQueryClientSingleton: QueryClient | undefined = undefined;
const getQueryClient = () => {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return createQueryClient();
  }
  // Browser: use singleton pattern to keep the same query client
  if (!clientQueryClientSingleton) {
    clientQueryClientSingleton = createQueryClient();
    applyCachePolicy(clientQueryClientSingleton);
  }

  return clientQueryClientSingleton;
};

export const api = createTRPCReact<AppRouter>();

/** IndexedDB-backed persister; created lazily because it needs `window`. */
let persister: ReturnType<typeof createAsyncStoragePersister> | undefined;
function getPersister() {
  if (typeof window === "undefined" || !("indexedDB" in window)) return null;
  if (!persister) {
    const store = createStore("guanlan-query-cache", "queries");
    persister = createAsyncStoragePersister({
      storage: {
        getItem: (key) => get<string>(key, store).then((v) => v ?? null),
        setItem: (key, value: string) => set(key, value, store),
        removeItem: (key) => del(key, store),
      },
      key: "trpc",
      throttleTime: 2000,
      // tRPC data carries Dates and Maps; plain JSON would flatten them.
      serialize: (client) => SuperJSON.stringify(client),
      deserialize: (text) => SuperJSON.parse(text),
    });
  }
  return persister;
}

/**
 * Inference helper for inputs.
 *
 * @example type HelloInput = RouterInputs['example']['hello']
 */
export type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Inference helper for outputs.
 *
 * @example type HelloOutput = RouterOutputs['example']['hello']
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export function TRPCReactProvider(props: { children: React.ReactNode }) {
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        httpBatchStreamLink({
          transformer: SuperJSON,
          url: getBaseUrl() + "/api/trpc",
          headers: () => {
            const headers = new Headers();
            headers.set("x-trpc-source", "nextjs-react");
            headers.set("x-quant-client", "workbench");
            return headers;
          },
        }),
      ],
    }),
  );

  const body = (
    <api.Provider client={trpcClient} queryClient={queryClient}>
      {props.children}
    </api.Provider>
  );
  // Restores the persisted cache once; afterwards only persisted queries'
  // new data is saved (see PersistProvider).
  return (
    <PersistProvider
      client={queryClient}
      persister={getPersister()}
      buster={process.env.NEXT_PUBLIC_CACHE_BUSTER ?? "dev"}
    >
      {body}
    </PersistProvider>
  );
}

function getBaseUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
