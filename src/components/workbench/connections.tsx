import { AlertSettings } from "../signals/alert-settings";
import { AlertControls } from "../signals/alert-controls";
import { FloppyDisk, FolderOpen } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, Segmented } from "../panels";
import { PanelVisibility } from "./keep-alive";
import { useEffect, useRef, useState } from "react";
import { settingsSchema, type Channel, type Settings } from "~/lib/domain";
import {
  acknowledgeSettings,
  changedSettings,
  reconcileSettings,
  settingsToSave,
} from "~/lib/settings/settings-draft";
import { usePanelVisible } from "./keep-alive";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { ConnectionDiagnostics } from "./connection-diagnostics";
import { connectionConfiguration } from "~/lib/settings/connection-check";
import { sameSetting } from "~/lib/settings/settings-draft";
import { useSnapshotCache } from "~/lib/stores/snapshot-cache";
import { useSettingsSession } from "~/lib/stores/settings-session";
import type { SettingsDraftState } from "~/lib/settings/settings-draft";
import { DataSection } from "./connections/data-section";
import { NewsSection } from "./connections/news-section";
import { ResearchSection } from "./connections/research-section";
import { NotificationsSection } from "./connections/notifications-section";
import { CryptoSection } from "./connections/crypto-section";
import { ThsdkSection } from "./connections/thsdk-section";
import type { ChannelDraft } from "./connections/shared";

const connectionSections = [
  { value: "data", label: "本地行情" },
  { value: "news", label: "新闻采集" },
  { value: "research", label: "研究模型与技能" },
  { value: "notifications", label: "通知渠道" },
  { value: "crypto", label: "数字货币" },
  { value: "thsdk", label: "同花顺行情" },
] as const;
type ConnectionSection = (typeof connectionSections)[number]["value"];

/** `?section=thsdk` deep link, validated against the known sections. */
function requestedSection(): ConnectionSection | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("section");
  return connectionSections.some((item) => item.value === value)
    ? (value as ConnectionSection)
    : null;
}

export function Connections({
  value,
  channels,
  coverage,
  notify,
  onScan,
  scanning,
}: {
  value: Settings;
  channels: Channel[];
  coverage: {
    counts: Record<string, number>;
    scannedAt: number;
    total: number;
  } | null;
  notify: (s: string) => void;
  onScan: () => void;
  scanning: boolean;
}) {
  const [section, setSection] = useState<ConnectionSection>("data");
  // Read the deep link after hydration so server and client render the same
  // initial section; the browser fixture has no router context, hence the
  // plain `window.location` read.
  useEffect(() => {
    const requested = requestedSection();
    if (requested) setSection(requested);
  }, []);
  const visible = usePanelVisible();
  const budget = api.newsBudget.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const skillCatalog = api.researchSkills.useQuery(undefined, {
    enabled: visible,
    staleTime: 60000,
  });
  const savedDraft = useSettingsSession((state) => state.draft);
  const draftState = savedDraft ?? { base: value, draft: value };
  const setDraftState = (
    change: (state: SettingsDraftState) => SettingsDraftState,
  ) =>
    useSettingsSession.getState().update({ base: value, draft: value }, change);
  const [saveError, setSaveError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const saving = useRef(false);
  const submittedDraft = useRef(value);
  const config = draftState.draft;
  const dirty = changedSettings(draftState).length > 0;
  const setConfig = (draft: Settings) => {
    setDraftState((state) => ({ ...state, draft }));
    setSaveError("");
    setFieldErrors({});
  };
  useEffect(() => {
    setDraftState((state) => reconcileSettings(state, value));
  }, [value]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const utils = api.useUtils(),
    [channel, setChannel] = useState<ChannelDraft>({
      name: "",
      type: "feishu" as Channel["type"],
      target: "",
      thread: "",
      secret: "",
      signingSecret: "",
      enabled: false,
    }),
    [editId, setEditId] = useState<string | undefined>();
  const onError = (e: { message: string }) => notify(e.message),
    save = api.saveSettings.useMutation({
      onSuccess: (_result, submitted) => {
        if (
          !sameSetting(
            connectionConfiguration(draftState.base),
            connectionConfiguration(settingsSchema.parse(submitted)),
          )
        )
          useSnapshotCache.getState().clearMarket();
        setDraftState((state) =>
          acknowledgeSettings(
            state,
            settingsSchema.parse(submitted),
            submittedDraft.current,
          ),
        );
        setSaveError("");
        notify("设置已保存");
        void utils.status.invalidate();
        void utils.securityProfile.invalidate();
        void utils.securityNames.invalidate();
        void utils.securities.invalidate();
      },
      onError: (error) => {
        setSaveError(error.message);
        onError(error);
      },
      onSettled: () => {
        saving.current = false;
      },
    }),
    saveChannel = api.saveChannel.useMutation({
      onSuccess: () => {
        notify("渠道已保存，尚未发送测试消息");
        setChannel({ ...channel, secret: "", signingSecret: "" });
        void utils.channels.invalidate();
      },
      onError,
    }),
    test = api.testChannel.useMutation({
      onSuccess: () => notify("测试通知已加入发送队列，请查看投递历史"),
      onError,
    });
  const submitSettings = () => {
    if (!dirty || saving.current) return;
    const parsed = settingsSchema.safeParse(settingsToSave(draftState, value));
    const errors: Record<string, string> = {};
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        errors[String(issue.path[0])] = "请检查此项的格式或允许范围。";
    if (
      config.calendar.some(
        (day) =>
          !Number.isFinite(Date.parse(day)) ||
          new Date(day).toISOString().slice(0, 10) !== day,
      )
    )
      errors.calendar = "请输入真实日期，格式为 YYYY-MM-DD，每行一个。";
    if (!parsed.success || Object.keys(errors).length) {
      setFieldErrors(errors);
      setSaveError("请检查目录、日期格式及数值范围后重试。设置尚未保存。");
      const first = document.getElementById(
        `setting-${Object.keys(errors)[0]}`,
      );
      const details = first?.closest("details");
      if (details) details.open = true;
      first?.focus();
      return;
    }
    saving.current = true;
    submittedDraft.current = config;
    setSaveError("");
    save.mutate(parsed.data);
  };
  const fieldProps = (name: string) => ({
    id: `setting-${name}`,
    "aria-invalid": Boolean(fieldErrors[name]),
    "aria-describedby": fieldErrors[name] ? `setting-error-${name}` : undefined,
  });
  const fieldError = (name: string) =>
    fieldErrors[name] && (
      <p id={`setting-error-${name}`} className="mb-2 text-nc-bad">
        {fieldErrors[name]}
      </p>
    );
  const beginEditChannel = (c: Channel) => {
    setEditId(c.id);
    setChannel({
      name: c.name,
      type: c.type,
      target: c.target,
      thread: c.thread,
      enabled: c.enabled,
      secret: "",
      signingSecret: "",
    });
  };
  const cancelEditChannel = () => {
    setEditId(undefined);
    setChannel({
      name: "",
      type: "feishu",
      target: "",
      thread: "",
      secret: "",
      signingSecret: "",
      enabled: false,
    });
  };
  const saveCurrentChannel = () =>
    saveChannel.mutate({
      ...channel,
      id: editId,
      secret: channel.secret || undefined,
    });
  return (
    <PageGrid>
      <Panel
        title="数据与连接设置"
        icon={FolderOpen}
        className="sticky top-14 z-10"
        note="保存以下路径、行情源、研究与通知策略。聊天渠道和数字货币连接分别保存。"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            role="status"
            data-settings-state={
              save.isPending ? "saving" : dirty ? "dirty" : "saved"
            }
          >
            {save.isPending
              ? "正在保存；可以继续编辑"
              : dirty
                ? "有未保存的修改 · 切换页面会保留草稿"
                : "设置已保存"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setDraftState((state) => ({
                  base: state.base,
                  draft: state.base,
                }));
                setSaveError("");
                setFieldErrors({});
              }}
            >
              撤销修改
            </Button>
            <Button
              onClick={submitSettings}
              disabled={!dirty || save.isPending}
            >
              <FloppyDisk size={14} />
              保存设置
            </Button>
          </div>
        </div>
        {saveError && (
          <p role="alert" className="mt-2 text-nc-bad">
            {saveError}
          </p>
        )}
        <div className="mt-3 border-t border-nc-border-soft pt-3">
          <Segmented
            label="数据与连接领域"
            value={section}
            onChange={setSection}
            options={connectionSections}
          />
        </div>
      </Panel>
      <PanelVisibility visible={section === "data"}>
        <div hidden={section !== "data"} className="nc-span-12 min-w-0">
          <DataSection
            config={config}
            setConfig={setConfig}
            fieldProps={fieldProps}
            fieldError={fieldError}
            dirty={dirty}
            savePending={save.isPending}
            scanning={scanning}
            onScan={onScan}
            value={value}
            coverage={coverage}
            onOpenThsdk={() => setSection("thsdk")}
          />
        </div>
      </PanelVisibility>
      <PanelVisibility visible={section === "news"}>
        <div hidden={section !== "news"} className="nc-span-12 min-w-0">
          <NewsSection
            config={config}
            setConfig={setConfig}
            fieldProps={fieldProps}
            fieldError={fieldError}
            value={value}
            dirty={dirty}
            savePending={save.isPending}
            budget={budget}
          />
        </div>
      </PanelVisibility>
      <PanelVisibility visible={section === "research"}>
        <div hidden={section !== "research"} className="nc-span-12 min-w-0">
          <ResearchSection
            config={config}
            setConfig={setConfig}
            fieldProps={fieldProps}
            fieldError={fieldError}
            skillCatalog={skillCatalog}
          />
        </div>
      </PanelVisibility>
      <PanelVisibility visible={section === "notifications"}>
        <div
          hidden={section !== "notifications"}
          className="nc-span-12 min-w-0"
        >
          <NotificationsSection
            config={config}
            setConfig={setConfig}
            fieldError={fieldError}
            channels={channels}
            channel={channel}
            onChannelChange={setChannel}
            editId={editId}
            onEdit={beginEditChannel}
            onCancelEdit={cancelEditChannel}
            onSaveChannel={saveCurrentChannel}
            saveChannelPending={saveChannel.isPending}
            onTestChannel={(id) => test.mutate(id)}
          />
        </div>
      </PanelVisibility>
      <PanelVisibility visible={section === "crypto"}>
        <div hidden={section !== "crypto"} className="nc-span-12 min-w-0">
          <CryptoSection />
        </div>
      </PanelVisibility>
      <PanelVisibility visible={section === "thsdk"}>
        <div hidden={section !== "thsdk"} className="nc-span-12 min-w-0">
          <ThsdkSection />
        </div>
      </PanelVisibility>
      <div className="nc-span-12">
        <AlertSettings
          value={config.alerts}
          onChange={(alerts) => setConfig({ ...config, alerts })}
        />
        <AlertControls channels={channels} />
      </div>
      <details className="nc-span-12 rounded-lg border bg-card p-4">
        <summary className="text-sm font-medium">
          连接诊断 · 基于已保存设置
        </summary>
        <div className="mt-4">
          <ConnectionDiagnostics value={draftState.base} dirty={dirty} />
        </div>
      </details>
    </PageGrid>
  );
}
