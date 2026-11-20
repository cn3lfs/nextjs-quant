"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowClockwise as RefreshCw,
  FloppyDisk,
  Key,
  PlugsConnected,
  QrCode,
  ShieldCheck,
  SignOut,
  UserCircle,
  WarningCircle,
} from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import type {
  ThsdkAuthMode,
  ThsdkStatusView,
} from "~/lib/settings/thsdk-settings";
import { PageGrid, Panel, Pill, type Tone } from "../../panels";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Field } from "../shared";
import { usePanelVisible } from "../keep-alive";

const authModeLabels: Record<ThsdkAuthMode, string> = {
  account: "个人账号",
  qrcode: "扫码登录",
  guest: "游客体验",
};

const stateLabels: Record<ThsdkStatusView["state"], string> = {
  unconfigured: "未配置",
  disabled: "已停用",
  logged_out: "未登录",
  qr_pending: "扫码中",
  authenticated: "已认证",
  error: "异常",
};

const stateTones: Record<ThsdkStatusView["state"], Tone> = {
  unconfigured: "idle",
  disabled: "idle",
  logged_out: "warn",
  qr_pending: "accent",
  authenticated: "ok",
  error: "bad",
};

type QrState = {
  scanUrl: string | null;
  imageUrl: string | null;
  authenticated: boolean;
  state: string;
};

const maskError = (message: string) => {
  const line = message.split("\n")[0]?.trim() || "未知错误";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};

/** 扫码链接只放行 http/https；javascript:、data: 等协议一律丢弃。 */
function safeHref(value: string | null | undefined) {
  if (!value) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** 二维码只放行 http/https 与 base64 编码的 png/jpeg/webp/gif 数据；其余丢弃。 */
function safeImageSrc(value: string | null | undefined) {
  if (!value) return null;
  if (value.startsWith("data:"))
    return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(
      value,
    )
      ? value
      : null;
  return safeHref(value);
}

function statusText(status: ThsdkStatusView | undefined) {
  if (!status) return { label: "读取状态…", tone: "idle" as Tone };
  return { label: stateLabels[status.state], tone: stateTones[status.state] };
}

/** `/system` 的同花顺行情配置、认证与实时状态。 */
export function ThsdkSection() {
  const visible = usePanelVisible();
  const utils = api.useUtils();
  const statusQuery = api.thsdkStatus.useQuery(undefined, {
    enabled: visible,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const status = statusQuery.data;
  const [dllPath, setDllPath] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [qr, setQr] = useState<QrState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const polling = useRef(false);

  useEffect(() => {
    setDllPath(status?.dllPath ?? "");
  }, [status?.dllPath]);

  const applyStatus = (next: ThsdkStatusView) => {
    utils.thsdkStatus.setData(undefined, next);
  };
  const onMutate = () => {
    setError("");
    setNotice("");
  };
  const onError = (cause: { message: string }) => {
    setNotice("");
    setError(`操作失败：${maskError(cause.message)}`);
  };
  const saveConfig = api.thsdkSaveConfig.useMutation({
    onSuccess: (next) => {
      applyStatus(next);
      // 停用后立即丢弃待完成二维码，避免残留轮询继续请求。
      if (!next.enabled) setQr(null);
      setNotice("配置已保存");
    },
    onMutate,
    onError,
  });
  const saveCredentials = api.thsdkSaveCredentials.useMutation({
    onSuccess: () => {
      setPassword("");
      setNotice("账号密码已保存（本机 DPAPI 加密）");
      void utils.thsdkStatus.invalidate();
    },
    onMutate,
    onError,
  });
  const forgetCredentials = api.thsdkForgetCredentials.useMutation({
    onSuccess: (result) => {
      setPassword("");
      setNotice(result.deleted ? "已删除本机凭据" : "本机没有可删除的凭据");
      void utils.thsdkStatus.invalidate();
    },
    onMutate,
    onError,
  });
  const loginAccount = api.thsdkLoginAccount.useMutation({
    onSuccess: (next) => {
      applyStatus(next);
      setNotice(
        next.state === "authenticated"
          ? "账号登录成功"
          : "登录未完成，请查看状态",
      );
    },
    onMutate,
    onError,
  });
  const loginGuest = api.thsdkLoginGuest.useMutation({
    onSuccess: (next) => {
      applyStatus(next);
      setNotice(
        next.state === "authenticated"
          ? "游客会话已建立"
          : "游客登录未完成，可能被源限流",
      );
    },
    onMutate,
    onError,
  });
  const startQrcode = api.thsdkStartQrcode.useMutation({
    onSuccess: (next) => {
      setQr(next);
      setNotice(next.authenticated ? "扫码登录成功" : "二维码已生成，请扫码");
      void utils.thsdkStatus.invalidate();
    },
    onMutate,
    onError,
  });
  const pollQrcode = api.thsdkPollQrcode.useMutation({
    onSuccess: (next) => {
      setQr(next);
      if (next.authenticated) {
        setNotice("扫码登录成功");
        void utils.thsdkStatus.invalidate();
      }
    },
    onError: (cause) => {
      setQr(null);
      onError(cause);
    },
    onSettled: () => {
      polling.current = false;
    },
  });
  const cancelQrcode = api.thsdkCancelQrcode.useMutation({
    onSuccess: () => {
      setQr(null);
      setNotice("已取消扫码");
      void utils.thsdkStatus.invalidate();
    },
    onMutate,
    onError,
  });
  const logout = api.thsdkLogout.useMutation({
    onSuccess: (next) => {
      applyStatus(next);
      setQr(null);
      setNotice("已登出同花顺");
    },
    onMutate,
    onError,
  });
  const pending =
    saveConfig.isPending ||
    saveCredentials.isPending ||
    forgetCredentials.isPending ||
    loginAccount.isPending ||
    loginGuest.isPending ||
    startQrcode.isPending ||
    pollQrcode.isPending ||
    cancelQrcode.isPending ||
    logout.isPending;
  const qrWaiting = Boolean(qr && !qr.authenticated);
  const scanHref = safeHref(qr?.scanUrl);
  const qrImageSrc = safeImageSrc(qr?.imageUrl);
  // 只在面板可见、THSDK 已启用且仍有待完成二维码时轮询；隐藏、停用或完成即零请求。
  const pollNow = useRef(pollQrcode.mutate);
  pollNow.current = pollQrcode.mutate;
  // 停用状态下一律不轮询；服务端已返回 disabled 时同步清掉本地二维码。
  const enabled = status?.enabled === true;
  useEffect(() => {
    if (status && !status.enabled) setQr(null);
  }, [status]);
  useEffect(() => {
    if (!visible || !qrWaiting || !enabled) return;
    const timer = window.setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      pollNow.current(undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [visible, qrWaiting, enabled]);
  const pill = statusText(status);
  const pathDirty = Boolean(
    status && dllPath.trim() !== status.dllPath && dllPath.trim().length <= 260,
  );
  const authMode = status?.authMode ?? "account";
  const accountLabel =
    status?.activeMode && status.state === "authenticated"
      ? `当前认证：${authModeLabels[status.activeMode]}`
      : "";
  const circuitOpen =
    status?.circuitOpenUntil !== null &&
    status?.circuitOpenUntil !== undefined &&
    status.circuitOpenUntil > Date.now();
  const canSaveCredentials =
    Boolean(username.trim()) &&
    Boolean(password) &&
    username.trim().length <= 120 &&
    password.length <= 200;
  // 表单提交只做一件事：保存本次输入的凭据。登录是独立按钮，绝不隐式覆盖 DPAPI 凭据。
  const submitAccount = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !canSaveCredentials) return;
    saveCredentials.mutate({ username: username.trim(), password });
  };
  return (
    <PageGrid>
      <Panel
        icon={PlugsConnected}
        title="同花顺行情（THSDK）"
        actions={<Pill tone={pill.tone}>{pill.label}</Pill>}
        note="同花顺行情经本机 hq.dll 读取，独立于本地通达信与在线来源；启用并认证后才会参与行情路由。凭据只保存在本机 Windows DPAPI。所有操作以服务端返回状态为准，待完成操作期间按钮禁用。"
      >
        {statusQuery.error ? (
          <p role="alert" className="text-nc-bad">
            同花顺状态读取失败：{maskError(statusQuery.error.message)}
          </p>
        ) : !status ? (
          <p role="status" className="text-nc-text-3">
            正在读取同花顺配置…
          </p>
        ) : (
          <div className="space-y-4">
            {status.lastErrorCode || status.lastErrorMessage ? (
              <p role="alert" className="text-nc-bad">
                最近异常
                {status.lastErrorCode ? `（${status.lastErrorCode}）` : ""}：
                {status.lastErrorMessage
                  ? maskError(status.lastErrorMessage)
                  : "未提供详情"}
              </p>
            ) : null}
            {circuitOpen && (
              <p role="alert" className="text-nc-warn">
                源返回限流/熔断，暂停请求至{" "}
                {new Date(status.circuitOpenUntil!).toLocaleTimeString(
                  "zh-CN",
                  { hour12: false },
                )}
                。期间不会自动重试。
              </p>
            )}
            {error && (
              <p role="alert" className="text-nc-bad">
                {error}
              </p>
            )}
            {notice && !error && (
              <p role="status" className="text-nc-ok">
                {notice}
              </p>
            )}

            <ol
              aria-label="启用同花顺行情三步"
              className="grid gap-2 rounded-lg border border-nc-border-soft bg-nc-inset p-3 sm:grid-cols-3"
            >
              {[
                {
                  step: "①",
                  title: "配置 hq.dll",
                  detail: status.configured ? "已完成" : "待填写路径并保存",
                  done: status.configured,
                },
                {
                  step: "②",
                  title: "开启启用开关",
                  detail: status.enabled ? "已完成" : "待开启",
                  done: status.enabled,
                },
                {
                  step: "③",
                  title: "登录认证",
                  detail:
                    status.state === "authenticated"
                      ? "已完成"
                      : "待登录（账号或扫码）",
                  done: status.state === "authenticated",
                },
              ].map((item) => (
                <li
                  key={item.step}
                  className="flex min-w-0 items-start gap-2 text-[13px]"
                >
                  <span
                    aria-hidden
                    className={
                      item.done
                        ? "flex h-6 w-6 flex-none items-center justify-center rounded-full border border-nc-ok-edge text-[12px] text-nc-ok"
                        : "flex h-6 w-6 flex-none items-center justify-center rounded-full border border-nc-border-soft text-[12px] text-nc-text-3"
                    }
                  >
                    {item.step}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{item.title}</span>
                    <span
                      className={
                        item.done
                          ? "block text-[12px] text-nc-ok"
                          : "block text-[12px] text-nc-text-3"
                      }
                    >
                      {item.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            <section className="space-y-2" aria-label="启用与 DLL 配置">
              <h4 className="flex items-center gap-1.5 text-[13px] font-medium">
                <PlugsConnected size={15} aria-hidden />
                基础配置 · 启用与 DLL
              </h4>
              <label className="flex items-center gap-2 text-[13px]">
                <Switch
                  checked={status.enabled}
                  disabled={pending}
                  onCheckedChange={(enabled) => saveConfig.mutate({ enabled })}
                />
                启用同花顺行情
              </label>
              <div className="form-grid">
                <Field label="hq.dll 本地路径">
                  <Input
                    value={dllPath}
                    disabled={pending}
                    placeholder="例如 C:\\ths\\hq.dll"
                    onChange={(event) => setDllPath(event.target.value)}
                  />
                </Field>
                <Field label="认证方式">
                  <Select
                    value={authMode}
                    disabled={pending}
                    onValueChange={(value) =>
                      saveConfig.mutate({ authMode: value as ThsdkAuthMode })
                    }
                  >
                    <SelectTrigger aria-label="首选认证方式">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(authModeLabels) as ThsdkAuthMode[]).map(
                        (mode) => (
                          <SelectItem key={mode} value={mode}>
                            {authModeLabels[mode]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !pathDirty}
                  onClick={() => saveConfig.mutate({ dllPath: dllPath.trim() })}
                >
                  <FloppyDisk size={14} />
                  保存 DLL 路径
                </Button>
                {!status.configured ? (
                  <Pill tone="idle">未配置 hq.dll</Pill>
                ) : status.dllKnownVersion ? (
                  <Pill tone="ok">
                    <ShieldCheck size={12} aria-hidden />
                    已知版本 {status.dllKnownVersion}
                  </Pill>
                ) : (
                  <Pill tone="warn">
                    <WarningCircle size={12} aria-hidden />
                    未识别的版本哈希
                  </Pill>
                )}
                <span className="text-[11px] text-nc-text-4">
                  库版本 {status.dllKnownVersion ?? "未知"} · 配置修订{" "}
                  {status.configRevision}
                </span>
              </div>
              <label className="flex items-start gap-2 text-[13px]">
                <Switch
                  checked={status.allowUnlistedHash}
                  disabled={pending}
                  onCheckedChange={(allowUnlistedHash) =>
                    saveConfig.mutate({ allowUnlistedHash })
                  }
                />
                <span>
                  允许未列名的 DLL 哈希
                  <span className="block text-[11px] text-nc-text-4">
                    仅在你确认文件来源时开启；未识别版本可能改变字段语义。
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-[13px]">
                <Switch
                  checked={status.allowAutoFallback}
                  disabled={pending}
                  onCheckedChange={(allowAutoFallback) =>
                    saveConfig.mutate({ allowAutoFallback })
                  }
                />
                <span>
                  允许参与自动兜底
                  <span className="block text-[11px] text-nc-text-4">
                    关闭后仅在行情源显式选择「同花顺」时使用，自动模式不会兜底到
                    THS。
                  </span>
                </span>
              </label>
              <p className="text-[11px] text-nc-text-4">
                {accountLabel || "尚未认证"}
                {status.hasSavedCredentials ? " · 已保存账号凭据" : ""}
              </p>
            </section>

            <section
              className="space-y-3 border-t border-nc-border-soft pt-3"
              aria-label="登录认证"
            >
              <h4 className="flex items-center gap-1.5 text-[13px] font-medium">
                <UserCircle size={15} aria-hidden />
                登录认证 · 请选择账号密码登录或扫码登录
              </h4>
              <div className="grid gap-4 md:grid-cols-2">
                <form
                  onSubmit={submitAccount}
                  className={`min-w-0 space-y-2 rounded-lg border bg-nc-card p-4 ${
                    authMode === "account"
                      ? "border-nc-accent-700"
                      : "border-nc-border-soft"
                  }`}
                >
                  <h5 className="flex items-center gap-1.5 text-[13px] font-medium">
                    <Key size={15} aria-hidden />
                    账号密码登录
                  </h5>
                  <Field label="账号">
                    <Input
                      value={username}
                      disabled={pending}
                      autoComplete="username"
                      placeholder="输入同花顺账号或手机号"
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </Field>
                  <Field label="密码">
                    <Input
                      type="password"
                      value={password}
                      disabled={pending}
                      autoComplete="current-password"
                      placeholder="输入登录密码，仅本机 DPAPI 加密保存"
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      type="submit"
                      disabled={pending || !canSaveCredentials}
                    >
                      <Key size={14} />
                      保存凭据
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      disabled={pending || !status.hasSavedCredentials}
                      onClick={() => loginAccount.mutate()}
                    >
                      账号登录
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      type="button"
                      disabled={pending || !status.hasSavedCredentials}
                      onClick={() => forgetCredentials.mutate()}
                    >
                      忘记凭据
                    </Button>
                  </div>
                  <p className="text-[11px] text-nc-text-4">
                    {status.hasSavedCredentials
                      ? "已保存账号凭据；点「账号登录」使用本机凭据登录，输入新账号密码只会覆盖保存，不会自动登录。忘记凭据只删除本机保存，不影响同花顺账号。"
                      : "先填写并保存凭据才能账号登录；忘记凭据只删除本机保存，不影响同花顺账号。"}
                  </p>
                </form>

                <div
                  className={`min-w-0 space-y-2 rounded-lg border bg-nc-card p-4 ${
                    authMode === "qrcode"
                      ? "border-nc-accent-700"
                      : "border-nc-border-soft"
                  }`}
                >
                  <h5 className="flex items-center gap-1.5 text-[13px] font-medium">
                    <QrCode size={15} aria-hidden />
                    扫码登录
                  </h5>
                  <p className="text-[12px] text-nc-text-3">
                    使用同花顺 App 扫描下方二维码完成登录。
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || qrWaiting}
                      onClick={() => startQrcode.mutate()}
                    >
                      开始扫码
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || !qr || !status.enabled}
                      onClick={() => {
                        polling.current = false;
                        pollQrcode.mutate();
                      }}
                    >
                      <RefreshCw size={14} />
                      手动检查
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || !qrWaiting}
                      onClick={() => cancelQrcode.mutate()}
                    >
                      取消扫码
                    </Button>
                  </div>
                  {qrWaiting && (
                    <p className="text-[11px] text-nc-text-4">
                      每 2.5 秒检查一次，面板隐藏、停用或完成后停止
                    </p>
                  )}
                  {qr ? (
                    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-nc-border-soft p-2">
                      {qrImageSrc ? (
                        // 二维码由源返回的 data/HTTP 图片，尺寸固定，不走 next/image 优化。
                        <img
                          src={qrImageSrc}
                          alt="同花顺扫码登录二维码"
                          className="h-36 w-36 rounded-md border border-nc-border-soft bg-card object-contain"
                        />
                      ) : qr.imageUrl ? (
                        <p className="text-[11px] text-nc-warn">
                          二维码图片协议不受信任，已隐藏。
                        </p>
                      ) : null}
                      <div className="min-w-0 space-y-1 text-[12px]">
                        <p>
                          扫码状态：{qr.authenticated ? "已认证" : qr.state}
                        </p>
                        {scanHref ? (
                          <a
                            className="break-all text-nc-accent-light underline"
                            href={scanHref}
                            target="_blank"
                            rel="noreferrer"
                          >
                            在新窗口打开扫码链接
                          </a>
                        ) : (
                          <p className="text-nc-text-4">
                            {qr.scanUrl
                              ? "扫码链接协议不受信任，已隐藏"
                              : "源未返回扫码链接"}
                          </p>
                        )}
                        <p className="text-[11px] text-nc-text-4">
                          二维码只用于本次登录；完成后自动停止轮询。
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-nc-border-soft bg-nc-inset p-3 text-center text-[12px] text-nc-text-4">
                      点击「开始扫码」生成同花顺登录二维码
                    </div>
                  )}
                </div>
              </div>

              <div
                className={`space-y-2 rounded-lg border bg-nc-card p-3 ${
                  authMode === "guest"
                    ? "border-nc-accent-700"
                    : "border-nc-border-soft"
                }`}
              >
                <h5 className="flex items-center gap-1.5 text-[13px] font-medium">
                  <WarningCircle size={15} aria-hidden />
                  游客快速体验
                </h5>
                <label className="flex items-start gap-2 text-[13px]">
                  <Switch
                    checked={status.guestModeEnabled}
                    disabled={pending}
                    onCheckedChange={(guestModeEnabled) =>
                      saveConfig.mutate({ guestModeEnabled })
                    }
                  />
                  允许显式游客登录
                </label>
                <p className="rounded-md border border-nc-border-soft bg-nc-inset p-2 text-[11.5px] leading-[1.6] text-nc-warn">
                  游客会话由同花顺分配，存在严格限频与并发限制，可能被限流、随时失效或返回空数据；
                  仅用于快速体验，不作为稳定行情来源。启用后仍需手动点击下方按钮，不会自动登录。
                </p>
                <Button
                  size="sm"
                  disabled={pending || !status.guestModeEnabled}
                  onClick={() => loginGuest.mutate()}
                >
                  一键游客登录
                </Button>
              </div>
            </section>

            <div className="flex flex-wrap items-center gap-2 border-t border-nc-border-soft pt-3">
              <Button
                size="sm"
                variant="danger"
                disabled={pending || status.state !== "authenticated"}
                onClick={() => logout.mutate()}
              >
                <SignOut size={14} />
                登出
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={statusQuery.isFetching}
                onClick={() => void statusQuery.refetch()}
              >
                <RefreshCw size={14} />
                刷新状态
              </Button>
              {statusQuery.isFetching && (
                <span className="text-[11px] text-nc-text-4">正在刷新…</span>
              )}
            </div>
          </div>
        )}
      </Panel>
    </PageGrid>
  );
}
