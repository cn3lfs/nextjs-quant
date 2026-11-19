"use client";

import { useEffect, useRef, useState } from "react";
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
  // 只在面板可见且仍有待完成二维码时轮询；隐藏或完成即零请求。
  const pollNow = useRef(pollQrcode.mutate);
  pollNow.current = pollQrcode.mutate;
  useEffect(() => {
    if (!visible || !qrWaiting) return;
    const timer = window.setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      pollNow.current(undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [visible, qrWaiting]);
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

            <section className="space-y-2" aria-label="启用与 DLL 配置">
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

            <section className="space-y-2 border-t border-nc-border-soft pt-3">
              <h4 className="flex items-center gap-1.5 text-[13px] font-medium">
                <UserCircle size={15} aria-hidden />
                个人账号
              </h4>
              <div className="form-grid">
                <Field label="账号">
                  <Input
                    value={username}
                    disabled={pending}
                    autoComplete="username"
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </Field>
                <Field label="密码">
                  <Input
                    type="password"
                    value={password}
                    disabled={pending}
                    autoComplete="current-password"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    pending ||
                    !username.trim() ||
                    username.trim().length > 120 ||
                    !password ||
                    password.length > 200
                  }
                  onClick={() =>
                    saveCredentials.mutate({
                      username: username.trim(),
                      password,
                    })
                  }
                >
                  <Key size={14} />
                  保存凭据
                </Button>
                <Button
                  size="sm"
                  disabled={pending || !status.hasSavedCredentials}
                  onClick={() => loginAccount.mutate()}
                >
                  账号登录
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending || !status.hasSavedCredentials}
                  onClick={() => forgetCredentials.mutate()}
                >
                  忘记凭据
                </Button>
              </div>
              {!status.hasSavedCredentials && (
                <p className="text-[11px] text-nc-text-4">
                  先保存凭据才能账号登录；忘记凭据只删除本机保存，不影响同花顺账号。
                </p>
              )}
            </section>

            <section className="space-y-2 border-t border-nc-border-soft pt-3">
              <h4 className="flex items-center gap-1.5 text-[13px] font-medium">
                <QrCode size={15} aria-hidden />
                扫码登录
              </h4>
              <div className="flex flex-wrap items-center gap-3">
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
                  disabled={pending || !qr}
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
                {qrWaiting && (
                  <span className="text-[11px] text-nc-text-4">
                    每 2.5 秒检查一次，面板隐藏或完成后停止
                  </span>
                )}
              </div>
              {qr && (
                <div className="flex flex-wrap items-start gap-3 rounded-lg border border-nc-border-soft p-2">
                  {qr.imageUrl ? (
                    // 二维码由源返回的 data/HTTP 图片，尺寸固定，不走 next/image 优化。
                    <img
                      src={qr.imageUrl}
                      alt="同花顺扫码登录二维码"
                      className="h-36 w-36 rounded-md border border-nc-border-soft bg-card object-contain"
                    />
                  ) : null}
                  <div className="min-w-0 space-y-1 text-[12px]">
                    <p>扫码状态：{qr.authenticated ? "已认证" : qr.state}</p>
                    {qr.scanUrl ? (
                      <a
                        className="break-all text-nc-accent-light underline"
                        href={qr.scanUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        在新窗口打开扫码链接
                      </a>
                    ) : (
                      <p className="text-nc-text-4">源未返回扫码链接</p>
                    )}
                    <p className="text-[11px] text-nc-text-4">
                      二维码只用于本次登录；完成后自动停止轮询。
                    </p>
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-2 border-t border-nc-border-soft pt-3">
              <h4 className="flex items-center gap-1.5 text-[13px] font-medium">
                <WarningCircle size={15} aria-hidden />
                游客快速体验
              </h4>
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
