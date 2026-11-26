import { expect, it } from "vitest";
import {
  alertDisplayCopy,
  alertModeLabel,
  glossary,
  termLabel,
} from "~/lib/common/ui-glossary";

it("统一空跑观察、空跑验证和正式提醒的展示名称", () => {
  expect(termLabel("shadow")).toBe("空跑观察");
  expect(alertModeLabel("shadow")).toBe("空跑观察");
  expect(termLabel("shadowForward")).toBe("空跑验证");
  expect(alertModeLabel("live")).toBe("正式提醒");
});

it.each(Object.entries(glossary))("词表展示值 %s 不含旧术语", (_key, label) => {
  expect(label).not.toMatch(/\b(?:shadow|live)\b|观察模式|观察前推|影子/i);
});

it.each([
  ["影子观察模式", "空跑观察"],
  ["影子前推", "空跑验证"],
  ["开启 live 提醒", "开启正式提醒"],
])("将旧消息中的 %s 转为统一展示名", (message, expected) => {
  expect(alertDisplayCopy(message)).toBe(expected);
});
