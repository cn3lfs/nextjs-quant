import { ChatCircle, PaperPlaneTilt, Plus } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, Pill } from "../../panels";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Checkbox } from "../../ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../ui/select";
import type { Channel, Settings } from "~/lib/domain";
import { Field } from "../shared";
import { NotificationPolicyFields } from "../../signals/notification-policy-fields";
import type { ChannelDraft, FieldError } from "./shared";

export function NotificationsSection({
  config,
  setConfig,
  fieldError,
  channels,
  channel,
  onChannelChange,
  editId,
  onEdit,
  onCancelEdit,
  onSaveChannel,
  saveChannelPending,
  onTestChannel,
}: {
  config: Settings;
  setConfig: (draft: Settings) => void;
  fieldError: FieldError;
  channels: Channel[];
  channel: ChannelDraft;
  onChannelChange: (channel: ChannelDraft) => void;
  editId: string | undefined;
  onEdit: (channel: Channel) => void;
  onCancelEdit: () => void;
  onSaveChannel: () => void;
  saveChannelPending: boolean;
  onTestChannel: (id: string) => void;
}) {
  return (
    <PageGrid>
      <Panel title="通知策略" icon={PaperPlaneTilt}>
        {fieldError("notificationPolicy")}
        <NotificationPolicyFields
          value={config.notificationPolicy}
          onChange={(notificationPolicy) =>
            setConfig({ ...config, notificationPolicy })
          }
        />
      </Panel>
      <Panel
        icon={PaperPlaneTilt}
        title="聊天推送渠道"
        note="单向通知，无需公网回调地址。保存不会发送消息；点击“发送测试通知”才会向所选目标发送测试内容。"
      >
        {channels.map((c) => (
          <div className="list-row" key={c.id}>
            <div>
              <div className="flex items-center gap-2">
                <ChatCircle size={16} className="text-nc-accent" />
                <strong>{c.name}</strong>
                <Pill tone={c.enabled ? "ok" : "idle"}>
                  {c.enabled ? "已启用" : "已暂停"}
                </Pill>
              </div>
              <p>{c.type} · 凭证已加密保存</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => onEdit(c)}>
              编辑
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onTestChannel(c.id)}
            >
              发送测试通知
            </Button>
          </div>
        ))}
        <h4>{editId ? "编辑渠道" : "添加渠道"}</h4>
        <div className="form-grid">
          <Field label="渠道名称">
            <Input
              value={channel.name}
              onChange={(e) =>
                onChannelChange({ ...channel, name: e.target.value })
              }
            />
          </Field>
          <Field label="平台">
            <Select
              value={channel.type}
              onValueChange={(value) =>
                onChannelChange({
                  ...channel,
                  type: value as Channel["type"],
                })
              }
            >
              <SelectTrigger aria-label="平台" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feishu">飞书群机器人</SelectItem>
                <SelectItem value="wecom">企业微信群机器人</SelectItem>
                <SelectItem value="telegram">Telegram Bot</SelectItem>
                <SelectItem value="discord">Discord Webhook</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={
              channel.type === "telegram" ? "Bot Token" : "机器人 Webhook 地址"
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={channel.secret}
              onChange={(e) =>
                onChannelChange({ ...channel, secret: e.target.value })
              }
              placeholder={
                editId ? "留空保留已有凭证" : "凭证仅保存到系统加密存储"
              }
            />
          </Field>
          {channel.type === "feishu" && (
            <Field label="签名密钥（可选）">
              <Input
                type="password"
                value={channel.signingSecret}
                onChange={(e) =>
                  onChannelChange({
                    ...channel,
                    signingSecret: e.target.value,
                  })
                }
              />
            </Field>
          )}
          {channel.type === "telegram" && (
            <Field label="Chat ID（私聊需先联系机器人）">
              <Input
                value={channel.target}
                onChange={(e) =>
                  onChannelChange({ ...channel, target: e.target.value })
                }
              />
            </Field>
          )}
          {["telegram", "discord"].includes(channel.type) && (
            <Field label="话题 / Thread ID（可选）">
              <Input
                value={channel.thread}
                onChange={(e) =>
                  onChannelChange({ ...channel, thread: e.target.value })
                }
              />
            </Field>
          )}
        </div>
        <div className="check-row">
          <label>
            <Checkbox
              checked={channel.enabled}
              onCheckedChange={(checked) =>
                onChannelChange({ ...channel, enabled: checked === true })
              }
            />
            启用此渠道接收订阅信号
          </label>
        </div>
        <div className="button-row">
          <Button onClick={onSaveChannel} disabled={saveChannelPending}>
            <Plus size={14} />
            保存渠道
          </Button>
          {editId && (
            <Button variant="ghost" onClick={onCancelEdit}>
              取消编辑
            </Button>
          )}
        </div>
      </Panel>
    </PageGrid>
  );
}
