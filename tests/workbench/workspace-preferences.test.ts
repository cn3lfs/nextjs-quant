import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { syncWorkspaceUiPreferences } from "~/lib/stores/workbench-ui-store";

type LoadPreferences = Parameters<typeof syncWorkspaceUiPreferences>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const local = {
  density: "compact",
  sidebarCollapsed: true,
  expandedGroups: ["资讯研报"],
  singleKeyShortcuts: false,
} as const;
const remote = {
  density: "comfort",
  sidebarCollapsed: false,
  expandedGroups: ["系统设置"],
  singleKeyShortcuts: true,
  closeToTray: true,
} as const;
const cacheKey = "guanlan-workbench-ui";
const cache = new Map<string, string>();

beforeEach(() => {
  vi.resetModules();
  cache.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => cache.get(key) ?? null,
      setItem: (key: string, value: string) => cache.set(key, value),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("reads local preferences synchronously and preserves them against the background response", async () => {
  cache.set(cacheKey, JSON.stringify({ state: local, version: 1 }));
  const {
    hydrateWorkbenchUi,
    syncWorkspaceUiPreferences,
    useWorkbenchUiStore,
  } = await import("~/lib/stores/workbench-ui-store");
  hydrateWorkbenchUi();
  expect(useWorkbenchUiStore.getState()).toMatchObject(local);
  const load = vi.fn(async () => ({
    ...remote,
    expandedGroups: [...remote.expandedGroups],
  }));
  const save = vi.fn(async () => {});
  const stop = syncWorkspaceUiPreferences(load, save);
  try {
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(useWorkbenchUiStore.getState()).toMatchObject(local);
    expect(save).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it("restores missing local preferences from SQLite without echoing them back", async () => {
  const {
    hydrateWorkbenchUi,
    syncWorkspaceUiPreferences,
    useWorkbenchUiStore,
  } = await import("~/lib/stores/workbench-ui-store");
  hydrateWorkbenchUi();
  const save = vi.fn(async () => {});
  const { closeToTray, ...ui } = remote;
  const stop = syncWorkspaceUiPreferences(
    async () => ({
      closeToTray,
      ...ui,
      expandedGroups: [...ui.expandedGroups],
    }),
    save,
  );
  try {
    await vi.waitFor(() =>
      expect(useWorkbenchUiStore.getState()).toMatchObject(ui),
    );
    expect(JSON.parse(cache.get(cacheKey)!)).toEqual({ state: ui, version: 1 });
    expect(save).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it("keeps edits across a slow initial read and serializes patches through a failed write", async () => {
  const {
    hydrateWorkbenchUi,
    syncWorkspaceUiPreferences,
    useWorkbenchUiStore,
  } = await import("~/lib/stores/workbench-ui-store");
  hydrateWorkbenchUi();
  const read = deferred<Awaited<ReturnType<LoadPreferences>>>();
  const firstWrite = deferred<void>();
  const load = vi.fn(() => read.promise);
  const save = vi
    .fn(async () => {})
    .mockImplementationOnce(() => firstWrite.promise);
  const stop = syncWorkspaceUiPreferences(load, save);
  try {
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const actions = useWorkbenchUiStore.getState();
    actions.toggleDensity();
    actions.toggleDensity();
    actions.toggleSidebar();
    actions.toggleGroup("选股筛选");
    actions.setSingleKeyShortcuts(false);
    actions.toggleZen();
    await vi.waitFor(() =>
      expect(save.mock.calls).toEqual([[{ density: "compact" }]]),
    );
    read.resolve({ ...remote, expandedGroups: [...remote.expandedGroups] });
    firstWrite.reject(new Error("write failed"));
    await vi.waitFor(() =>
      expect(save.mock.calls).toEqual([
        [{ density: "compact" }],
        [{ density: "comfort" }],
        [{ sidebarCollapsed: true }],
        [{ expandedGroups: ["选股筛选"] }],
        [{ singleKeyShortcuts: false }],
      ]),
    );
    const state = {
      density: "comfort",
      sidebarCollapsed: true,
      expandedGroups: ["选股筛选"],
      singleKeyShortcuts: false,
    };
    expect(useWorkbenchUiStore.getState()).toMatchObject({
      ...state,
      zenMode: true,
    });
    expect(JSON.parse(cache.get(cacheKey)!)).toEqual({ state, version: 1 });
  } finally {
    stop();
  }
});

it("silently aborts the read and stops syncing after unmount", async () => {
  const { syncWorkspaceUiPreferences, useWorkbenchUiStore } =
    await import("~/lib/stores/workbench-ui-store");
  const load = vi.fn(
    (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const save = vi.fn(async () => {});
  const stop = syncWorkspaceUiPreferences(load, save);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  stop();
  useWorkbenchUiStore.getState().toggleDensity();
  expect(load.mock.calls[0]?.[0].aborted).toBe(true);
  expect(save).not.toHaveBeenCalled();
});
