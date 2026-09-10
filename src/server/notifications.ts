import { securityLabel } from "./securities";
import { createHmac, randomUUID } from "node:crypto";
import { fetch as proxyFetch, ProxyAgent } from "undici";
import {
  channelSchema,
  type Channel,
  type Delivery,
  type Signal,
  type Report,
} from "~/lib/domain";
import { get, put, list, sqlite, atomic } from "./db";
import { deliveryCancellationReason } from "./delivery-authorization";
import { saveSecret, readSecret } from "./vault";
import { settings } from "./settings";
import {
  NotificationPolicyStore,
  renderSummary,
} from "./notification-policy-store";
import {
  chinaClock,
  minutes,
  customQuiet,
  summaryWindow,
  type NotificationDecision,
  type PolicyUnit,
} from "~/lib/notification-policy";
type Credential = { secret: string; signingSecret?: string };
export function validateDestination(type: Channel["type"], secret: string) {
  if (type === "telegram") {
    if (!/^\d+:[\w-]+$/.test(secret))
      throw new Error("Telegram Bot Token 格式不正确");
    return;
  }
  const u = new URL(secret),
    hosts = {
      feishu: ["open.feishu.cn"],
      wecom: ["qyapi.weixin.qq.com"],
      discord: ["discord.com", "discordapp.com"],
    }[type];
  if (
    u.protocol !== "https:" ||
    !hosts.includes(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  )
    throw new Error("请使用对应平台官方 HTTPS 机器人地址");
  if (type === "feishu" && !u.pathname.startsWith("/open-apis/bot/v2/hook/"))
    throw new Error("飞书机器人地址无效");
  if (
    type === "wecom" &&
    (u.pathname !== "/cgi-bin/webhook/send" || !u.searchParams.get("key"))
  )
    throw new Error("企业微信机器人地址无效");
  if (type === "discord" && !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname))
    throw new Error("Discord Webhook 地址无效");
}
export async function saveChannel(input: unknown) {
  const value = channelSchema.parse(input),
    id = value.id ?? `channel-${randomUUID()}`,
    old = get<Channel>(id);
  let credential = await readSecret<Credential>(id);
  if (value.secret) {
    validateDestination(value.type, value.secret);
    credential = { secret: value.secret, signingSecret: value.signingSecret };
    await saveSecret(id, credential);
  } else if (old && old.type !== value.type)
    throw new Error("更换渠道类型需要重新填写凭证");
  if (!credential) throw new Error("请填写机器人凭证");
  if (value.type === "telegram" && !value.target)
    throw new Error("请填写 Chat ID");
  return put<Channel>("channel", id, {
    id,
    name: value.name,
    type: value.type,
    enabled: value.enabled,
    target: value.target,
    thread: value.thread,
    configured: true,
  });
}
export function renderSignal(signal: Signal) {
  if (signal.breakout?.latest) {
    const point = signal.breakout.latest;
    const sides = [point.long, point.short].filter((s) => s.status === "是");
    const price = (v: { price: number } | null) =>
      v ? v.price.toFixed(2) : "未知";
    return `规则信号 · ${securityLabel(signal.symbol)}\n策略：双突破 · 日线 · ${signal.breakout.version}\n数据日期：${signal.date} · 收盘 ${point.close.toFixed(2)}\n${sides.map((s) => `${s.direction === "long" ? "向上突破" : "向下突破"} · 质量 ${s.quality}\n趋势线 ${s.line?.value.toFixed(2) ?? "未知"} · 关键位 ${price(s.keyLevel)}（${s.keyLevel?.source ?? "未知"}）\n前20日量比 ${point.volumeRatio?.toFixed(2) ?? "未知"}\n止损结构位 ${price(s.risk.stop)} · 目标一 ${price(s.risk.target1)} · 目标二 ${price(s.risk.target2)}\n风险回报比 ${s.risk.ratio}（目标二）\n失效观察：收盘反穿突破关键位 ${price(s.keyLevel)}；结构止损 ${price(s.risk.stop)}`).join("\n")}\n方法：${signal.breakout.method.skillId} · ${signal.breakout.method.files[0]?.hash.slice(0, 8)}\n来源：${signal.source} / 不复权\n信号：${signal.id}`;
  }
  if (signal.czsc) {
    const detail = signal.czsc;
    return `规则信号 · ${securityLabel(signal.symbol)}\n策略：缠论买卖点 · 日线 · 配置 ${detail.config}\n数据日期：${signal.date}（本日新确认，点位日期见下）\n策略版本：${detail.strategyVersion} · DLL：${detail.dllVersion}\n${detail.points.map((p) => `买卖点：第${["", "一", "二", "三"][Math.abs(p.kind)]}类${p.kind > 0 ? "买" : "卖"}点 · ${p.date}\n信号质量：${p.quality === 2 ? "强质量" : p.quality === 1 ? "确认" : "观察"}\n所属中枢：${p.center ? `ZG ${p.center.ZG.toFixed(2)} / ZD ${p.center.ZD.toFixed(2)}（${p.center.startDate}—${p.center.endDate}）` : "未知（DLL未关联中枢）"}\n背驰依据：${p.divergence}\n失效条件：${p.invalidation}`).join("\n\n")}\n来源：${signal.source} / 不复权\n信号：${signal.id}`;
  }
  return `规则信号 · ${securityLabel(signal.symbol)}\n策略：${signal.strategy.name} (${signal.strategy.fast}/${signal.strategy.slow})\n周期：${signal.period} · 数据：${signal.date}\n收盘：${signal.metrics.close.toFixed(2)} · 涨跌：${signal.metrics.change.toFixed(2)}%\n短均线 ${signal.metrics.fast.toFixed(2)} > 长均线 ${signal.metrics.slow.toFixed(2)}，条件由不满足变为满足\n来源：${signal.source ?? "tdx-local"} / 不复权\n信号：${signal.id}\n生成：${new Date(signal.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`;
}
function notificationUnits(
  signal: Signal,
): { unit: PolicyUnit; signal: Signal }[] {
  const common = { symbol: signal.symbol, date: signal.date };
  if (signal.czsc)
    return signal.czsc.points.map((point) => ({
      unit: {
        ...common,
        strategy: "czsc",
        endpointDate: point.date,
        direction: point.kind > 0 ? "long" : "short",
        score: point.quality,
        pointKey: `${signal.czsc!.config}:${point.date}:${point.kind}`,
      },
      signal: { ...signal, czsc: { ...signal.czsc!, points: [point] } },
    }));
  const result = signal.breakout,
    point = result?.latest;
  if (point && result)
    return [point.long, point.short]
      .filter((side) => side.status === "是")
      .map((side) => ({
        unit: {
          ...common,
          strategy: "dual-breakout",
          endpointDate: signal.date,
          direction: side.direction,
          score: side.score ?? -1,
        },
        signal: {
          ...signal,
          breakout: {
            ...result,
            latest: {
              ...point,
              ...(side.direction === "long"
                ? { short: { ...point.short, status: "否" as const } }
                : { long: { ...point.long, status: "否" as const } }),
            },
          },
        },
      }));
  // Frozen legacy strategies keep their existing behavior.
  return [];
}

export function enqueue(
  signal: Signal,
  channelIds: string[],
  kind: "signal" | "analysis",
  report?: Report,
) {
  for (const channelId of channelIds) {
    const channel = get<Channel>(channelId);
    const policyStore = new NotificationPolicyStore(sqlite());
    const units = notificationUnits(signal);
    const pages =
      kind === "signal" && units.length
        ? units.map((u) => renderSignal(u.signal))
        : [
            kind === "signal"
              ? renderSignal(signal)
              : `AI 解读 · ${securityLabel(signal.symbol)}\n${report?.summary ?? ""}\n风险：${report?.risks.join("；") ?? ""}\n证据：${report?.citations.join("、") ?? ""}\n关联信号：${signal.id}`,
          ];
    for (const [page, body] of pages.entries()) {
      const id = `delivery-${signal.id}-${channelId}-${kind}${page ? `-${page}` : ""}`;
      if (get(id)) continue;
      const unit = units[page]?.unit ?? units[0]?.unit;
      const decision = unit
        ? policyStore.decide(
            unit,
            signal.id,
            channelId,
            id,
            body,
            Date.now(),
            kind,
          )
        : undefined;
      if (!channel?.enabled) {
        if (decision)
          policyStore.update(decision, "ledger", "渠道已停用或删除");
        continue;
      }
      if (decision && kind === "analysis") {
        const parent = policyStore
          .decisions()
          .filter(
            (d) =>
              d.signalId === signal.id &&
              d.channelId === channelId &&
              d.messageKind !== "analysis",
          );
        if (!parent.length || parent.some((d) => d.tier !== "immediate")) {
          policyStore.update(
            decision,
            "ledger",
            "原信号未立即投递；AI解读保留报告，不追加通知",
          );
          continue;
        }
      }
      if (decision && decision.tier !== "immediate") continue;
      put<Delivery>("delivery", id, {
        id,
        signalId: signal.id,
        ...(decision ? { policyDecisionIds: [decision.id] } : {}),
        channelId,
        kind,
        title: kind === "signal" ? "规则信号" : "AI 解读",
        body,
        status: "pending",
        attempts: 0,
        nextAt: Date.now(),
        expiresAt: signal.expiresAt,
        createdAt: Date.now(),
      });
    }
  }
}
export function testDelivery(channelId: string) {
  if (!get<Channel>(channelId)) throw new Error("渠道不存在");
  const id = `test-${randomUUID()}`;
  return put<Delivery>("delivery", id, {
    id,
    signalId: id,
    channelId,
    kind: "test",
    title: "测试通知",
    body: "【测试通知】量化工作台渠道连接测试。这不是交易信号。",
    status: "pending",
    attempts: 0,
    nextAt: Date.now(),
    expiresAt: Date.now() + 600000,
    createdAt: Date.now(),
  });
}
/** One deterministic outbox message per destination/day, never a new sender. */
export function flushSummaries(now = Date.now()) {
  atomic(() => {
    const store = new NotificationPolicyStore(sqlite());
    const policy = store.policy(),
      clock = chinaClock(now);
    const ready = summaryWindow(now, store.days(), policy);
    const groups = new Map<string, NotificationDecision[]>();
    for (const d of store.decisions()) {
      if (d.tier !== "summary" || d.summaryId || !d.channelId || !d.signalId)
        continue;
      if (
        d.date < clock.date ||
        (d.date === clock.date &&
          minutes(clock.time) >= minutes(policy.summaryTime) + 15)
      ) {
        store.update(d, "ledger", "错过当日汇总窗口；保留台账，不跨日补推");
        continue;
      }
      if (!ready || d.date !== clock.date) continue;
      const probe = {
        signalId: d.signalId,
        channelId: d.channelId,
        kind: "signal",
      } as Delivery;
      const reason = deliveryCancellationReason(probe);
      if (reason || !get<Channel>(d.channelId)?.enabled) {
        store.update(d, "ledger", reason ?? "渠道已停用或删除");
        continue;
      }
      if (d.messageKind === "analysis") {
        store.update(d, "ledger", "AI解读保留报告，不重复加入规则汇总");
        continue;
      }
      if (store.duplicate(d, d.channelId, now)) {
        store.update(
          d,
          "ledger",
          `同标的同策略同方向 ${policy.dedupTradingDays} 个交易日内已推送`,
        );
        continue;
      }
      const items = groups.get(d.channelId) ?? [];
      items.push(d);
      groups.set(d.channelId, items);
    }
    for (const [channelId, items] of groups) {
      const id = `delivery-summary-${clock.date}-${channelId}`;
      const existing = get<Delivery>(id);
      if (
        existing &&
        (existing.attempts > 0 || existing.status !== "pending")
      ) {
        for (const d of items)
          store.update(d, "ledger", "当日汇总已封卷；迟到信号仅记台账");
        continue;
      }
      const prior =
        existing?.policyDecisionIds
          ?.map((id) => store.read<NotificationDecision>(id))
          .filter((d): d is NotificationDecision => !!d) ?? [];
      const decisions = [...prior, ...items].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      for (const d of decisions)
        store.save("notification-decision", d.id, { ...d, summaryId: id });
      put<Delivery>("delivery", id, {
        id,
        signalId: id,
        channelId,
        kind: "summary",
        title: "收盘信号汇总",
        body: renderSummary(clock.date, decisions),
        policyDecisionIds: decisions.map((d) => d.id),
        summarySignalIds: [...new Set(decisions.map((d) => d.signalId!))],
        status: "pending",
        attempts: 0,
        nextAt: now,
        createdAt: now,
        expiresAt:
          Date.parse(`${clock.date}T${policy.summaryTime}:00+08:00`) +
          15 * 60000,
      });
    }
  });
}
function adoptQueuedPolicy(
  item: Delivery,
  store: NotificationPolicyStore,
  now: number,
) {
  if (
    item.policyDecisionIds?.length ||
    !["signal", "analysis"].includes(item.kind)
  )
    return;
  const signal = get<Signal>(item.signalId);
  if (!signal) return;
  let units = notificationUnits(signal);
  if (!units.length) return;
  if (signal.czsc) {
    const base = `delivery-${signal.id}-${item.channelId}-${item.kind}`;
    const page = item.id === base ? 0 : Number(item.id.slice(base.length + 1));
    units = units.slice(page, page + 1);
  }
  const decisions = units.map(({ unit }, i) =>
    store.decide(
      unit,
      signal.id,
      item.channelId,
      `${item.id}:adopt-${i}`,
      item.body,
      now,
      item.kind as "signal" | "analysis",
    ),
  );
  item.policyDecisionIds = decisions.map((d) => d.id);
  // A pre-P2 breakout message can contain two sides. Never forward a filtered
  // side in that old combined body; retain eligible units in the single digest.
  if (decisions.some((d) => d.tier !== "immediate")) {
    for (const d of decisions)
      if (d.tier === "immediate")
        store.update(d, "summary", "旧队列混合档位，合并收盘汇总");
    store.cancel(item, "旧队列已应用P2分级，转汇总或台账");
    return false;
  }
  return true;
}

function refreshUnsentSummary(
  item: Delivery,
  store: NotificationPolicyStore,
  now: number,
) {
  if (item.kind !== "summary" || item.attempts > 0) return;
  const eligible: NotificationDecision[] = [];
  for (const id of item.policyDecisionIds ?? []) {
    const d = store.read<NotificationDecision>(id);
    if (!d) continue;
    const reason = deliveryCancellationReason({
      ...item,
      kind: "signal",
      signalId: d.signalId!,
    });
    if (reason) store.update(d, "ledger", reason);
    else if (d.tier === "summary") eligible.push(d);
  }
  item.policyDecisionIds = eligible.map((d) => d.id);
  item.summarySignalIds = [...new Set(eligible.map((d) => d.signalId!))];
  item.body = renderSummary(chinaClock(now).date, eligible);
}
export function notificationRequest(
  channel: Channel,
  credential: Credential,
  delivery: Delivery,
  now = Date.now(),
) {
  validateDestination(channel.type, credential.secret);
  const body = delivery.body.replace(
    /@everyone|@here|<at\b[^>]*>.*?<\/at>/gi,
    "[提及已省略]",
  );
  let url = credential.secret,
    payload: Record<string, unknown>;
  if (channel.type === "telegram") {
    url = `https://api.telegram.org/bot${credential.secret}/sendMessage`;
    payload = {
      chat_id: channel.target,
      text: body.slice(0, 4000),
      ...(channel.thread ? { message_thread_id: Number(channel.thread) } : {}),
    };
  } else if (channel.type === "discord") {
    url += `?wait=true${channel.thread ? `&thread_id=${encodeURIComponent(channel.thread)}` : ""}`;
    payload = { content: body.slice(0, 1900), allowed_mentions: { parse: [] } };
  } else if (channel.type === "wecom") {
    payload = { msgtype: "text", text: { content: truncateBytes(body, 1900) } };
  } else {
    const timestamp = String(Math.floor(now / 1000));
    payload = {
      msg_type: "text",
      content: { text: body.slice(0, 6000) },
      ...(credential.signingSecret
        ? {
            timestamp,
            sign: createHmac(
              "sha256",
              `${timestamp}\n${credential.signingSecret}`,
            )
              .update("")
              .digest("base64"),
          }
        : {}),
    };
  }
  return { url, payload };
}
function truncateBytes(text: string, max: number) {
  let result = "";
  for (const ch of text) {
    if (Buffer.byteLength(result + ch) > max) return result + "…";
    result += ch;
  }
  return result;
}
export class SendError extends Error {
  constructor(
    message: string,
    public permanent = false,
    public retryAfter = 0,
  ) {
    super(message);
  }
}
export function classifyResponse(
  type: Channel["type"],
  status: number,
  data: Record<string, unknown>,
  retryHeader: string | null,
) {
  const code = Number(data.errcode ?? data.code ?? 0),
    parameters = data.parameters as { retry_after?: number } | undefined;
  if (status === 429 || code === 45009 || code === 11232)
    throw new SendError(
      "渠道限流",
      false,
      Number(retryHeader ?? parameters?.retry_after ?? data.retry_after ?? 60) *
        1000,
    );
  if (status >= 500) throw new SendError(`渠道服务暂不可用 (${status})`);
  if (
    status >= 400 ||
    data.ok === false ||
    ((type === "wecom" || type === "feishu") && code !== 0)
  )
    throw new SendError(
      `渠道拒绝请求 (${status}/${code})，请检查凭证和目标`,
      true,
    );
}
class DeliveryStopped extends Error {
  constructor(
    message: string,
    public status: "cancelled" | "expired" = "cancelled",
  ) {
    super(message);
  }
}
async function send(channel: Channel, delivery: Delivery) {
  const credential = await readSecret<Credential>(channel.id);
  const reason = deliveryCancellationReason(delivery);
  if (reason) throw new DeliveryStopped(reason);
  if (delivery.expiresAt <= Date.now())
    throw new DeliveryStopped("通知已过期", "expired");
  const currentChannel = get<Channel>(channel.id);
  if (!currentChannel || (!currentChannel.enabled && delivery.kind !== "test"))
    throw new DeliveryStopped("渠道已停用或删除");
  if (!credential) throw new SendError("凭证不存在", true);
  // Reading credentials is asynchronous; a quiet boundary may have been crossed
  // since claim. Delay through the existing retry mechanism before touching HTTP.
  if (delivery.policyDecisionIds?.length) {
    const policyStore = new NotificationPolicyStore(sqlite());
    const now = Date.now(),
      policy = policyStore.policy(),
      days = policyStore.days();
    if (
      delivery.kind === "summary"
        ? !summaryWindow(now, days, policy)
        : customQuiet(now, policy)
    )
      throw new SendError("进入静默时段，等待允许投递窗口", false, 60000);
  }
  const { url, payload } = notificationRequest(channel, credential, delivery),
    proxy = settings().proxy;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  try {
    const response = await proxyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      ...(dispatcher ? { dispatcher } : {}),
    });
    const data = (await response.json()) as Record<string, unknown>;
    classifyResponse(
      channel.type,
      response.status,
      data,
      response.headers.get("retry-after"),
    );
    return String(
      data.id ??
        (data.result as { message_id?: number } | undefined)?.message_id ??
        "accepted",
    );
  } finally {
    await dispatcher?.close();
  }
}
const scope = globalThis as typeof globalThis & {
  quantOutbox?: { running: boolean; lastSent: Map<string, number> };
};
const state = (scope.quantOutbox ??= {
  running: false,
  lastSent: new Map<string, number>(),
});
export async function drain(sendFn = send, now = Date.now()) {
  if (state.running) return;
  state.running = true;
  try {
    flushSummaries(now);
    const policyStore = new NotificationPolicyStore(sqlite());
    const pending = sqlite()
      .prepare(
        "SELECT payload FROM records WHERE kind='delivery' AND json_extract(payload,'$.status')='pending' ORDER BY updated_at ASC LIMIT 500",
      )
      .all() as { payload: string }[];
    for (const row of pending) {
      const queued = JSON.parse(row.payload) as Delivery;
      const claim = atomic(() => {
        const item = get<Delivery>(queued.id);
        if (!item) return null;
        if (item.status !== "pending") return null;
        if (adoptQueuedPolicy(item, policyStore, now) === false) return null;
        if (item.expiresAt <= now) {
          put("delivery", item.id, { ...item, status: "expired" });
          for (const id of item.policyDecisionIds ?? []) {
            const d = policyStore.read<NotificationDecision>(id);
            if (d) policyStore.update(d, "ledger", "通知已过期，不补推");
          }
          return null;
        }
        refreshUnsentSummary(item, policyStore, now);
        const reason = deliveryCancellationReason(item);
        if (reason) {
          for (const id of item.policyDecisionIds ?? []) {
            const d = policyStore.read<NotificationDecision>(id);
            if (d) policyStore.update(d, "ledger", reason);
          }
          put("delivery", item.id, {
            ...item,
            status: "cancelled",
            error: reason,
          });
          return null;
        }
        if (item.nextAt > now) return null;
        const channel = get<Channel>(item.channelId);
        if (!channel || (!channel.enabled && item.kind !== "test")) return null;
        if (now - (state.lastSent.get(channel.id) ?? 0) < 3000) return null;
        if (!policyStore.claim(item, now)) return null;
        const current = {
          ...item,
          status: "sending" as const,
          attempts: item.attempts + 1,
        };
        put("delivery", item.id, current);
        return { channel, current };
      });
      if (!claim) continue;
      const { channel, current } = claim;
      state.lastSent.set(channel.id, now);
      try {
        const remoteId = await sendFn(channel, current);
        put("delivery", current.id, {
          ...current,
          status: "sent",
          remoteId,
          error: undefined,
        });
      } catch (error) {
        if (error instanceof DeliveryStopped) {
          put("delivery", current.id, {
            ...current,
            status: error.status,
            error: error.message,
          });
          continue;
        }
        const permanent = error instanceof SendError && error.permanent,
          delay =
            error instanceof SendError && error.retryAfter > 0
              ? error.retryAfter
              : Math.min(300000, 5000 * 2 ** (current.attempts - 1));
        put("delivery", current.id, {
          ...current,
          status: permanent || current.attempts >= 5 ? "failed" : "pending",
          nextAt: now + delay,
          error:
            error instanceof SendError
              ? error.message
              : "网络或发送异常；重试可能产生重复，按信号编号识别",
        });
      }
    }
  } finally {
    state.running = false;
  }
}
export function recoverDeliveries() {
  const rows = sqlite()
    .prepare(
      "SELECT payload FROM records WHERE kind='delivery' AND json_extract(payload,'$.status')='sending'",
    )
    .all() as { payload: string }[];
  for (const row of rows) {
    const item = JSON.parse(row.payload) as Delivery;
    const reason = deliveryCancellationReason(item);
    if (reason) {
      put("delivery", item.id, { ...item, status: "cancelled", error: reason });
      continue;
    }
    put("delivery", item.id, {
      ...item,
      status: item.attempts >= 5 ? "failed" : "pending",
      error: "上次发送结果不确定，重试可能重复",
      nextAt: Date.now(),
    });
  }
}
