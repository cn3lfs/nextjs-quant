import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  DEFAULT_WATCHLIST_GROUP_ID,
  DEFAULT_WATCHLIST_GROUP_NAME,
  DEFAULT_WATCHLIST_SYMBOLS,
  MAX_WATCHLIST_GROUPS,
  MAX_WATCHLIST_SYMBOLS_PER_GROUP,
  watchlistGroupAddSymbolsSchema,
  watchlistGroupCreateSchema,
  watchlistGroupDeleteSchema,
  watchlistGroupRemoveSymbolSchema,
  watchlistGroupRenameSchema,
  watchlistGroupSetSymbolsSchema,
  watchlistGroupSymbolsSchema,
  type WatchlistGroup,
} from "~/lib/market/watchlist-groups";
import { atomic, get, put } from "../db";

const groupsKey = "watchlist-groups";

function persistGroups(groups: WatchlistGroup[]) {
  put(groupsKey, groupsKey, groups);
  const union = [...new Set(groups.flatMap((group) => group.symbols))];
  return put(
    "watchlist",
    "watchlist",
    union.slice(0, MAX_WATCHLIST_SYMBOLS_PER_GROUP),
  );
}

function initialGroups(): WatchlistGroup[] {
  const now = Date.now();
  return [
    {
      id: DEFAULT_WATCHLIST_GROUP_ID,
      name: DEFAULT_WATCHLIST_GROUP_NAME,
      symbols: watchlistGroupSymbolsSchema.parse(
        get<string[]>("watchlist") ?? DEFAULT_WATCHLIST_SYMBOLS,
      ),
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function defaultGroup(groups: WatchlistGroup[]) {
  return (
    groups.find((group) => group.id === DEFAULT_WATCHLIST_GROUP_ID) ??
    groups[0]!
  );
}

function requireGroup(groups: WatchlistGroup[], groupId: string) {
  const group = groups.find((item) => item.id === groupId);
  if (!group) throw new Error("自选列表不存在");
  return group;
}

function requireAvailableName(
  groups: WatchlistGroup[],
  name: string,
  exceptId?: string,
) {
  if (
    groups.some(
      (group) =>
        group.id !== exceptId &&
        group.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error("自选列表名称已存在");
}

function editGroups<T>(edit: (groups: WatchlistGroup[]) => T) {
  return atomic(() => {
    const groups = get<WatchlistGroup[]>(groupsKey) ?? initialGroups();
    const result = edit(groups);
    const legacySymbols = persistGroups(groups);
    return { result, legacySymbols };
  });
}

export function listWatchlistGroups() {
  const groups = get<WatchlistGroup[]>(groupsKey) ?? initialGroups();
  return { groups, defaultGroupId: defaultGroup(groups).id };
}

export function createWatchlistGroup(
  input: z.input<typeof watchlistGroupCreateSchema>,
) {
  const { name, symbols = [] } = watchlistGroupCreateSchema.parse(input);
  return editGroups((groups) => {
    if (groups.length >= MAX_WATCHLIST_GROUPS)
      throw new Error(`最多可创建 ${MAX_WATCHLIST_GROUPS} 个自选列表`);
    requireAvailableName(groups, name);
    const now = Date.now();
    const group = {
      id: randomUUID(),
      name,
      symbols,
      createdAt: now,
      updatedAt: now,
    };
    groups.push(group);
    return { group, groups };
  }).result;
}

export function renameWatchlistGroup(
  input: z.input<typeof watchlistGroupRenameSchema>,
) {
  const { groupId, name } = watchlistGroupRenameSchema.parse(input);
  return editGroups((groups) => {
    const group = requireGroup(groups, groupId);
    requireAvailableName(groups, name, groupId);
    group.name = name;
    group.updatedAt = Date.now();
    return { group, groups };
  }).result;
}

export function deleteWatchlistGroup(
  input: z.input<typeof watchlistGroupDeleteSchema>,
) {
  const { groupId } = watchlistGroupDeleteSchema.parse(input);
  return editGroups((groups) => {
    const group = requireGroup(groups, groupId);
    if (groups.length === 1) throw new Error("至少保留一个自选列表");
    groups.splice(groups.indexOf(group), 1);
    return { groups, defaultGroupId: defaultGroup(groups).id };
  }).result;
}

function replaceSymbols(group: WatchlistGroup, symbols: string[]) {
  group.symbols = symbols;
  group.updatedAt = Date.now();
}

export function setWatchlistGroupSymbols(
  input: z.input<typeof watchlistGroupSetSymbolsSchema>,
) {
  const { groupId, symbols } = watchlistGroupSetSymbolsSchema.parse(input);
  return editGroups((groups) => {
    const group = requireGroup(groups, groupId);
    replaceSymbols(group, symbols);
    return { group, groups };
  }).result;
}

export function addSymbolsToWatchlistGroup(
  input: z.input<typeof watchlistGroupAddSymbolsSchema>,
) {
  const { groupId, symbols } = watchlistGroupAddSymbolsSchema.parse(input);
  return editGroups((groups) => {
    const group = requireGroup(groups, groupId);
    const merged = watchlistGroupSymbolsSchema.parse([
      ...group.symbols,
      ...symbols,
    ]);
    const addedCount = merged.length - group.symbols.length;
    replaceSymbols(group, merged);
    return {
      group,
      addedCount,
      duplicateCount: symbols.length - addedCount,
      groups,
    };
  }).result;
}

export function removeSymbolFromWatchlistGroup(
  input: z.input<typeof watchlistGroupRemoveSymbolSchema>,
) {
  const { groupId, symbol } = watchlistGroupRemoveSymbolSchema.parse(input);
  return editGroups((groups) => {
    const group = requireGroup(groups, groupId);
    replaceSymbols(
      group,
      group.symbols.filter((value) => value !== symbol),
    );
    return { group, groups };
  }).result;
}

export function pinSymbolToWatchlistGroup(
  input: z.input<typeof watchlistGroupRemoveSymbolSchema>,
) {
  const { groupId, symbol } = watchlistGroupRemoveSymbolSchema.parse(input);
  return editGroups((groups) => {
    const group = requireGroup(groups, groupId);
    if (!group.symbols.includes(symbol))
      throw new Error("该证券不在当前自选列表中");
    replaceSymbols(group, [
      symbol,
      ...group.symbols.filter((value) => value !== symbol),
    ]);
    return { group, groups };
  }).result;
}

export function syncLegacyWatchlistToDefault(symbols: string[]) {
  const unique = watchlistGroupSymbolsSchema.parse(symbols);
  return editGroups((groups) => {
    const def = defaultGroup(groups);
    const existingDefault = new Set(def.symbols);
    const otherGroupSymbols = new Set(
      groups
        .filter((group) => group.id !== def.id)
        .flatMap((group) => group.symbols),
    );
    const filtered = unique.filter(
      (symbol) => existingDefault.has(symbol) || !otherGroupSymbols.has(symbol),
    );
    replaceSymbols(def, filtered);
  }).legacySymbols;
}
