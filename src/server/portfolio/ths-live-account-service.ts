import { venueBindingSchema } from "trading-strategies";
import { z } from "zod";
import { chinaDate } from "~/lib/market/security-trading-status";
import { get, put, readRecordSnapshot, remove, sqlite } from "../db";
import { getPipelineGlobalConfig } from "../db/deployment-repository";
import {
  pipelineLiveVaultId,
  resolveVenueAdapter,
} from "../execution/venue-router";
import { deleteSecret, readSecret, saveSecret } from "../vault";

const recordKind = "ths-live-account";
const text = z.string().trim().min(1);
export const thsLiveAccountSaveSchema = z
  .object({
    id: text.optional(),
    name: text,
    accountId: text,
    endpointUrl: text,
    token: z.string().trim().optional(),
  })
  .strict();

type Account = {
  id: string;
  name: string;
  accountId: string;
  endpointUrl: string;
  createdAt: number;
  updatedAt: number;
};

function bindingFor({
  accountId,
  endpointUrl,
}: Pick<Account, "accountId" | "endpointUrl">) {
  const binding = {
    kind: "cn_broker_live",
    broker: "ths_live",
    accountId,
    endpointUrl,
  } as const;
  venueBindingSchema.parse(binding);
  return binding;
}

const recordId = (accountId: string) => `${recordKind}:${accountId}`;

function requireAccount(id: string) {
  const account = id.startsWith(recordKind + ":")
    ? get<Account>(id)
    : undefined;
  if (!account || account.id !== id || recordId(account.accountId) !== id)
    throw new Error("同花顺实盘账户不存在");
  return account;
}

type BridgeCredential = {
  token: string;
  endpointUrl: string;
  allowedOrigin: string;
};

async function readBoundCredential(binding: ReturnType<typeof bindingFor>) {
  const credential = await readSecret<BridgeCredential>(
    pipelineLiveVaultId(binding),
  );
  const origin = new URL(binding.endpointUrl).origin;
  if (
    credential?.token?.trim() &&
    credential.allowedOrigin === origin &&
    new URL(credential.endpointUrl).origin === origin
  )
    return credential;
}

async function describe(account: Account, liveKillSwitchEnabled: boolean) {
  const binding = bindingFor(account);
  const credential = await readBoundCredential(binding).catch(() => undefined);
  return {
    id: account.id,
    name: account.name,
    accountId: account.accountId,
    endpointUrl: account.endpointUrl,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasCredential: Boolean(credential),
    liveKillSwitchEnabled,
  };
}

export async function listThsLiveAccounts() {
  const accounts = readRecordSnapshot(recordKind, (rows: Iterable<Account>) => [
    ...rows,
  ]);
  const enabled = getPipelineGlobalConfig(sqlite()).autoLiveEnabled;
  return Promise.all(accounts.map((account) => describe(account, enabled)));
}

// The dashboard and the pipeline share one vault entry per broker account ID.
// Exclude overlapping edits/deletions while DPAPI is doing asynchronous I/O.
const pending = new Set<string>();
async function changeAccount<T>(id: string, change: () => Promise<T>) {
  if (pending.has(id)) throw new Error("同花顺实盘账户正在更新");
  pending.add(id);
  try {
    return await change();
  } finally {
    pending.delete(id);
  }
}

export async function saveThsLiveAccount(
  input: z.input<typeof thsLiveAccountSaveSchema>,
) {
  const { id, name, accountId, endpointUrl, token } =
    thsLiveAccountSaveSchema.parse(input);
  const binding = bindingFor({ accountId, endpointUrl });
  const key = recordId(accountId);
  if (id !== undefined && id !== key)
    throw new Error("修改实盘账户编号需另行登记");
  return changeAccount(key, async () => {
    const previous = id ? requireAccount(id) : get<Account>(key);
    const vaultId = pipelineLiveVaultId(binding);
    // The old credential can still leak even when the endpoint's origin changes.
    const existingCredential = await readSecret<BridgeCredential | string>(
      vaultId,
    ).catch(() => {
      throw new Error("无法核验现有实盘凭证，请重试");
    });
    const existingToken =
      typeof existingCredential === "string"
        ? existingCredential
        : existingCredential?.token;
    const tokens = [
      token,
      typeof existingToken === "string" ? existingToken.trim() : undefined,
    ];
    const now = Date.now();
    const account: Account = {
      id: key,
      name,
      accountId,
      endpointUrl,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (
      Object.values(account).some(
        (field: unknown) =>
          typeof field === "string" &&
          (/\bauthorization\s*:|\bbearer\s+\S/i.test(field) ||
            tokens.some((secret) => secret && field.includes(secret))),
      )
    )
      throw new Error("账户公开字段不能包含鉴权凭证");

    put(recordKind, key, account);
    if (token) {
      await saveSecret(vaultId, {
        token,
        endpointUrl,
        allowedOrigin: new URL(endpointUrl).origin,
      }).catch(() => {
        throw new Error("账户资料已保存，实盘凭证写入失败，请重试");
      });
    }
    return describe(account, getPipelineGlobalConfig(sqlite()).autoLiveEnabled);
  });
}

export async function deleteThsLiveAccount(id: string) {
  return changeAccount(id, async () => {
    const account = requireAccount(id);
    if (!(await deleteSecret(pipelineLiveVaultId(bindingFor(account)))))
      throw new Error("实盘凭证删除失败，请重试");
    remove(id);
    return { id };
  });
}

export async function readThsLiveAccountSnapshot(id: string) {
  const binding = bindingFor(requireAccount(id));
  let token: string | undefined;
  const venue = resolveVenueAdapter(binding, {
    readCredential: async () => {
      const credential = await readBoundCredential(binding);
      token = credential?.token.trim();
      return credential;
    },
  });
  try {
    const state = await venue.readAccountState(
      binding,
      chinaDate(Date.now()),
      sqlite(),
    );
    // Only symbols are free text in the public snapshot.
    const usedToken = token;
    if (
      usedToken &&
      state.positions.some(({ symbol }) => symbol.includes(usedToken))
    )
      throw new Error("实盘桥接返回了无效持仓");
    const { cash, equity, drawdownPct, positions } = state;
    return {
      cash,
      equity,
      drawdownPct,
      positions: positions.map(({ symbol, quantity, sellable, lastPrice }) => ({
        symbol,
        quantity,
        sellable,
        lastPrice,
      })),
      fetchedAt: Date.now(),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("live-kill-switch-off")
    )
      throw new Error("live-kill-switch-off：实盘总开关未开启，无法读取账户");
    if (
      error instanceof Error &&
      error.message.startsWith("live_venue_not_configured")
    )
      throw new Error("实盘桥接凭证不可用，请检查账户配置");
    throw new Error("同花顺实盘账户查询失败，请检查桥接服务");
  }
}
