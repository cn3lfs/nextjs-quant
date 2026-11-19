"use client";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";

/** 两档信息密度，对应 tokens.css 的 html[data-density] 扩展。 */
export const densityOptions = ["comfort", "compact"] as const;
export type Density = (typeof densityOptions)[number];
export const densityLabels: Readonly<Record<Density, string>> = {
  comfort: "舒适",
  compact: "紧凑",
};

/** 宽屏侧栏最多同时展开 3 组：当前活跃组 + 最近手动展开的 2 组。 */
export const maxExpandedGroups = 3;

export type WorkbenchUiState = {
  density: Density;
  /** 宽轨 216px ↔ 图标窄轨 56px；窄屏仍由既有断点自动切换。 */
  sidebarCollapsed: boolean;
  /** 用户手动展开的工作区组名，按最近使用排序。 */
  expandedGroups: string[];
  /** 专注模式不持久化：下次打开应用回到正常壳层。 */
  zenMode: boolean;
  singleKeyShortcuts: boolean;
  setDensity: (density: Density) => void;
  toggleDensity: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  toggleGroup: (label: string) => void;
  setZenMode: (zen: boolean) => void;
  toggleZen: () => void;
  setSingleKeyShortcuts: (enabled: boolean) => void;
};

type WorkspaceUiPreferences = Pick<
  WorkbenchUiState,
  "density" | "sidebarCollapsed" | "expandedGroups" | "singleKeyShortcuts"
>;

function uiPreferences(state: WorkspaceUiPreferences): WorkspaceUiPreferences {
  return {
    density: state.density,
    sidebarCollapsed: state.sidebarCollapsed,
    expandedGroups: state.expandedGroups,
    singleKeyShortcuts: state.singleKeyShortcuts,
  };
}

const cachedPreferencesSchema = z.object({
  density: z.enum(densityOptions),
  sidebarCollapsed: z.boolean(),
  expandedGroups: z.array(z.string()),
  singleKeyShortcuts: z.boolean(),
});

let hasLocalPreferences = false;
let pendingSave = Promise.resolve();

export const useWorkbenchUiStore = create<WorkbenchUiState>()(
  persist<WorkbenchUiState, [], [], WorkspaceUiPreferences>(
    (set) => ({
      density: "comfort",
      sidebarCollapsed: false,
      expandedGroups: [],
      zenMode: false,
      singleKeyShortcuts: true,
      setDensity: (density) => set({ density }),
      toggleDensity: () =>
        set((state) => ({
          density: state.density === "comfort" ? "compact" : "comfort",
        })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleGroup: (label) =>
        set((state) => ({
          expandedGroups: state.expandedGroups.includes(label)
            ? state.expandedGroups.filter((group) => group !== label)
            : // 当前活跃组固定占一个位置，手动展开最多再占两个。
              [...state.expandedGroups, label].slice(-(maxExpandedGroups - 1)),
        })),
      setZenMode: (zenMode) => set({ zenMode }),
      toggleZen: () => set((state) => ({ zenMode: !state.zenMode })),
      setSingleKeyShortcuts: (singleKeyShortcuts) =>
        set({ singleKeyShortcuts }),
    }),
    {
      name: "guanlan-workbench-ui",
      version: 1,
      // 维持 SSR 的默认值，再在浏览器布局阶段同步读取缓存。
      skipHydration: true,
      storage: createJSONStorage<WorkspaceUiPreferences>(() => ({
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => {
          try {
            window.localStorage.setItem(key, value);
          } catch {
            // 存储受限时仍保留内存状态和数据库同步。
          }
        },
        removeItem: (key) => window.localStorage.removeItem(key),
      })),
      merge: (cached, state) => {
        const parsed = cachedPreferencesSchema.safeParse(cached);
        if (!parsed.success) return state;
        hasLocalPreferences = true;
        return { ...state, ...parsed.data };
      },
      partialize: uiPreferences,
    },
  ),
);

export function hydrateWorkbenchUi() {
  const storage = useWorkbenchUiStore.persist;
  if (!storage.hasHydrated()) {
    void Promise.resolve(storage.rehydrate()).catch(() => {});
  }
}

/** 只在壳层挂载时接通数据库。修改即时反映到 UI，写入按操作顺序执行。 */
export function syncWorkspaceUiPreferences(
  load: (signal: AbortSignal) => Promise<WorkspaceUiPreferences>,
  save: (patch: Partial<WorkspaceUiPreferences>) => Promise<unknown>,
) {
  const controller = new AbortController();
  let applyingDatabasePreferences = false;
  const unsubscribe = useWorkbenchUiStore.subscribe((next, previous) => {
    if (applyingDatabasePreferences) return;
    const patch: Partial<WorkspaceUiPreferences> = {};
    if (next.density !== previous.density) patch.density = next.density;
    if (next.sidebarCollapsed !== previous.sidebarCollapsed)
      patch.sidebarCollapsed = next.sidebarCollapsed;
    if (next.expandedGroups !== previous.expandedGroups)
      patch.expandedGroups = next.expandedGroups;
    if (next.singleKeyShortcuts !== previous.singleKeyShortcuts)
      patch.singleKeyShortcuts = next.singleKeyShortcuts;
    if (!Object.keys(patch).length) return;
    hasLocalPreferences = true;
    pendingSave = pendingSave
      .then(() => save(patch))
      .then(
        () => {},
        () => {},
      );
  });

  const { signal } = controller;
  void Promise.resolve()
    .then(() => (signal.aborted ? undefined : load(signal)))
    .then((preferences) => {
      // 数据库补齐新窗口的本机缓存，保留已显示的偏好和等待期间的操作。
      if (signal.aborted || !preferences || hasLocalPreferences) return;
      applyingDatabasePreferences = true;
      try {
        useWorkbenchUiStore.setState(uiPreferences(preferences));
        hasLocalPreferences = true;
      } finally {
        applyingDatabasePreferences = false;
      }
    })
    .catch(() => {});
  return () => {
    unsubscribe();
    controller.abort();
  };
}
