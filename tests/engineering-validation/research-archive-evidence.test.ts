import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  ArchiveEvidence,
  ArchiveText,
  ArchiveMetadata,
  archiveStamp,
} from "../../src/components/research/archive-evidence";

it("does not evaluate evidence renderers before the disclosure is opened", () => {
  const html = renderToStaticMarkup(
    createElement(ArchiveEvidence, {
      title: "证据",
      children: () => {
        throw Error("heavy evidence must remain deferred");
      },
    }),
  );
  expect(html).toContain("证据");
  expect(html).not.toContain("<pre");
});
it("bounds a megabyte source to one readable segment and makes remaining content explicit", () => {
  const text = "a".repeat(7999) + "🧪" + "b".repeat(1_000_000);
  const html = renderToStaticMarkup(createElement(ArchiveText, { text }));
  expect(html.length).toBeLessThan(12000);
  expect(html).toContain("下一段证据");
  expect(html).toContain("完整内容保留在报告导出中");
  expect(html).not.toContain("\ud83e"); // no isolated first half of the boundary emoji
});
it("labels missing generation metadata and formats valid times in Beijing", () => {
  const html = renderToStaticMarkup(createElement(ArchiveMetadata, {}));
  expect(html).toContain("时间未知");
  expect(html).toContain("未记录");
  expect(archiveStamp(null)).toBe("时间未知");
  expect(archiveStamp(undefined)).toBe("时间未知");
  expect(archiveStamp(Date.parse("2026-09-27T16:00:00Z"))).toContain(
    "2026/9/28",
  );
});
