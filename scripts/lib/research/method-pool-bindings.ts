// The binding table now lives in the shared pure layer so the lab server can
// classify imported evidence without executing a CLI script:
// src/lib/research/method-pool-bindings.ts
// This shim only keeps an old path resolvable; remove it after confirming no
// caller still imports scripts/lib/research/method-pool-bindings.
export * from "../../../src/lib/research/method-pool-bindings";
