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
    return `规则信号 · ${securityLabel(signal.symbol)}\n策略：缠论买卖点 · 日线 · 配置 ${detail.config}\n数据日期：${signal.date}（本日新确认，点位日期见下）\n策略版本：${detail.strategyVersion} · DLL：${detail.dllVersion}\n${detail.points.map((p) => `买卖点：第${["", "一", "二", "三"][Math.abs(p.kind)]}类${p.kind > 0 ? "买" : "卖"}点 · ${p.date}\n信号质量：${p.quality === 2 ? "强质量" : "确认"}\n所属中枢：${p.center ? `ZG ${p.center.ZG.toFixed(2)} / ZD ${p.center.ZD.toFixed(2)}（${p.center.startDate}—${p.center.endDate}）` : "未知（DLL未关联中枢）"}\n背驰依据：${p.divergence}\n失效条件：${p.invalidation}`).join("\n\n")}\n来源：${signal.source} / 不复权\n信号：${signal.id}`;
  }
  return `规则信号 · ${securityLabel(signal.symbol)}\n策略：${signal.strategy.name} (${signal.strategy.fast}/${signal.strategy.slow})\n周期：${signal.period} · 数据：${signal.date}\n收盘：${signal.metrics.close.toFixed(2)} · 涨跌：${signal.metrics.change.toFixed(2)}%\n短均线 ${signal.metrics.fast.toFixed(2)} > 长均线 ${signal.metrics.slow.toFixed(2)}，条件由不满足变为满足\n来源：${signal.source ?? "tdx-local"} / 不复权\n信号：${signal.id}\n生成：${new Date(signal.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`;
}
export function enqueue(
  signal: Signal,
  channelIds: string[],
  kind: "signal" | "analysis",
  report?: Report,
) {
  for (const channelId of channelIds) {
    const channel = get<Channel>(channelId);
    if (!channel?.enabled) continue;
    // One point per message keeps every required field inside all four channel limits.
    const pages =
      kind === "signal" && signal.czsc
        ? signal.czsc.points.map((point) =>
            renderSignal({
              ...signal,
              czsc: { ...signal.czsc!, points: [point] },
            }),
          )
        : [
            kind === "signal"
              ? renderSignal(signal)
              : `AI 解读 · ${securityLabel(signal.symbol)}\n${report?.summary ?? ""}\n风险：${report?.risks.join("；") ?? ""}\n证据：${report?.citations.join("、") ?? ""}\n关联信号：${signal.id}`,
          ];
    for (const [page, body] of pages.entries()) {
      const id = `delivery-${signal.id}-${channelId}-${kind}${page ? `-${page}` : ""}`;
      if (get(id)) continue;
      put<Delivery>("delivery", id, {
        id,
        signalId: signal.id,
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
        if (item.expiresAt <= now) {
          put("delivery", item.id, { ...item, status: "expired" });
          return null;
        }
        const reason = deliveryCancellationReason(item);
        if (reason) {
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
