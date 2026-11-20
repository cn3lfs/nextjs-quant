import { beforeEach, expect, it, vi } from "vitest";
import { jobsRouter } from "~/server/api/routers/jobs";
import { get, put, remove } from "~/server/db";

// The status query normally starts background schedulers unrelated to watchlists.
vi.mock("~/server/runtime", () => ({ startRuntime: vi.fn() }));
const api = jobsRouter.createCaller({ headers: new Headers() });
const a = "sh600519",
  b = "sz000001",
  c = "sz300750",
  d = "bj430047";

beforeEach(() => {
  remove("watchlist-groups");
  remove("watchlist");
});

it.each([
  { legacy: undefined, expected: [a, b, c] },
  { legacy: [d, b, d], expected: [d, b] },
  { legacy: [], expected: [] },
])(
  "seeds the default group once from $legacy and preserves an empty list",
  async ({ legacy, expected }) => {
    if (legacy) put("watchlist", "watchlist", legacy);
    const initial = await api.watchlistGroups();
    expect(initial).toEqual({
      groups: [
        {
          id: "default",
          name: "默认自选",
          symbols: expected,
          createdAt: expect.any(Number),
          updatedAt: expect.any(Number),
        },
      ],
      defaultGroupId: "default",
    });
    expect(get("watchlist-groups")).toBeUndefined();
    expect(get("watchlist")).toEqual(legacy);
    expect(await api.watchlistGroups()).toEqual({
      ...initial,
      groups: initial.groups.map((g) => ({
        ...g,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      })),
    });
  },
);

it("creates, renames and deletes groups, rejecting ambiguous names and deletion of the last group", async () => {
  const { group, groups } = await api.watchlistGroupCreate({
    name: "  Growth ",
    symbols: [d, b, d],
  });
  expect(group).toMatchObject({ name: "Growth", symbols: [d, b] });
  expect(groups.map((g) => g.id)).toEqual(["default", group.id]);
  await expect(api.watchlistGroupCreate({ name: "  gRoWtH" })).rejects.toThrow(
    "名称已存在",
  );
  await expect(
    api.watchlistGroupRename({ groupId: group.id, name: " 默认自选 " }),
  ).rejects.toThrow("名称已存在");
  await expect(
    api.watchlistGroupRename({ groupId: "missing", name: "新组" }),
  ).rejects.toThrow("不存在");
  await expect(
    api.watchlistGroupDelete({ groupId: "missing" }),
  ).rejects.toThrow("不存在");
  const renamed = await api.watchlistGroupRename({
    groupId: group.id,
    name: "  观察 ",
  });
  expect(renamed.group).toMatchObject({
    id: group.id,
    name: "观察",
    createdAt: group.createdAt,
    symbols: [d, b],
  });
  expect((await api.status()).watchlist).toEqual([a, b, c, d]);
  const remaining = await api.watchlistGroupDelete({ groupId: group.id });
  expect(remaining.defaultGroupId).toBe("default");
  expect((await api.status()).watchlist).toEqual([a, b, c]);
  await expect(
    api.watchlistGroupDelete({ groupId: "default" }),
  ).rejects.toThrow("至少保留一个自选列表");
  expect(await api.watchlistGroups()).toEqual(remaining);
});

it("counts duplicates within the batch and across the group, and removes shared symbols only from the selected group", async () => {
  const { group } = await api.watchlistGroupCreate({
    name: "观察",
    symbols: [d],
  });
  const groupId = group.id;
  const added = await api.watchlistGroupAddSymbols({
    groupId,
    symbols: [d, b, b, a],
  });
  expect(added).toMatchObject({
    addedCount: 2,
    duplicateCount: 2,
    group: { symbols: [d, b, a] },
  });
  const removed = await api.watchlistGroupRemoveSymbol({ groupId, symbol: b });
  expect(removed.group.symbols).toEqual([d, a]);
  expect((await api.status()).watchlist).toEqual([a, b, c, d]);
  const set = await api.watchlistGroupSetSymbols({
    groupId: "default",
    symbols: [c, b, c],
  });
  expect(set.group.symbols).toEqual([c, b]);
  expect((await api.status()).watchlist).toEqual([c, b, d, a]);
});

it("legacy writes replace the default group's symbols, falling back to the first group after deletion", async () => {
  const first = (await api.watchlistGroupCreate({ name: "一", symbols: [d] }))
    .group;
  const second = (await api.watchlistGroupCreate({ name: "二", symbols: [a] }))
    .group;
  expect(await api.watchlist([b, b])).toEqual([b, d, a]);
  expect((await api.watchlistGroups()).groups.map((g) => g.symbols)).toEqual([
    [b],
    [d],
    [a],
  ]);
  // Legacy callers that echo the combined watchlist plus a new symbol must not copy other groups into default.
  expect(await api.watchlist([b, d, a, c])).toEqual([b, c, d, a]);
  expect((await api.watchlistGroups()).groups[0]!.symbols).toEqual([b, c]);
  const pinned = await api.watchlistGroupPinSymbol({
    groupId: "default",
    symbol: c,
  });
  expect(pinned.group.symbols).toEqual([c, b]);
  expect(await api.watchlistGroupDelete({ groupId: "default" })).toEqual({
    groups: [first, second],
    defaultGroupId: first.id,
  });
  expect((await api.watchlistGroups()).defaultGroupId).toBe(first.id);
  expect(await api.watchlist([c, c])).toEqual([c, a]);
  expect((await api.status()).watchlist).toEqual([c, a]);
  expect((await api.watchlistGroups()).groups.map((g) => g.symbols)).toEqual([
    [c],
    [a],
  ]);
});

it("allows 500 distinct symbols per group, rejects overflow atomically and caps only the legacy union", async () => {
  const symbols = Array.from(
    { length: 500 },
    (_, i) => `sz${String(i).padStart(6, "0")}`,
  );
  const groupId = "default";
  await api.watchlistGroupSetSymbols({
    groupId,
    symbols: [...symbols, symbols[0]!],
  });
  const { group } = await api.watchlistGroupCreate({
    name: "其他",
    symbols: [d],
  });
  expect((await api.status()).watchlist).toEqual(symbols);
  const before = await api.watchlistGroups();
  const overflow = [...symbols, a];
  await expect(
    api.watchlistGroupSetSymbols({ groupId, symbols: overflow }),
  ).rejects.toThrow("500");
  await expect(
    api.watchlistGroupCreate({ name: "超限", symbols: overflow }),
  ).rejects.toThrow("500");
  await expect(
    api.watchlistGroupAddSymbols({ groupId, symbols: [symbols[0]!, a] }),
  ).rejects.toThrow("500");
  expect(await api.watchlistGroups()).toEqual(before);
  expect(get("watchlist")).toEqual(symbols);
  expect(
    (await api.watchlistGroupAddSymbols({ groupId, symbols: [symbols[0]!] }))
      .duplicateCount,
  ).toBe(1);
  await api.watchlistGroupRemoveSymbol({ groupId, symbol: symbols[0]! });
  expect((await api.status()).watchlist).toEqual([...symbols.slice(1), d]);
  expect((await api.watchlistGroups()).groups).toContainEqual(group);
});

it("validates names and symbols and counts the default group toward the 30-group limit", async () => {
  await expect(api.watchlistGroupCreate({ name: "   " })).rejects.toThrow(
    "不能为空",
  );
  await expect(
    api.watchlistGroupCreate({ name: "长".repeat(33) }),
  ).rejects.toThrow("32");
  await expect(
    api.watchlistGroupCreate({ name: "观察", symbols: ["600519"] }),
  ).rejects.toThrow();
  for (let i = 1; i < 30; i++)
    await api.watchlistGroupCreate({ name: `组 ${i}` });
  await expect(api.watchlistGroupCreate({ name: "额外" })).rejects.toThrow(
    "30",
  );
  expect((await api.watchlistGroups()).groups).toHaveLength(30);
});
