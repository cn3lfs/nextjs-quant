import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NewsTime } from "~/components/news/news-time";
import {
  NEWS_TIME_FALLBACK,
  newsTime,
  newsTimeIso,
  newsTimeShort,
} from "~/lib/news/news-time";

const published = "2026-11-18T13:35:22Z";
const collected = "2026-11-18T13:36:05Z";

describe("news display time", () => {
  it("shows the same instant as Beijing 24-hour time with seconds", () => {
    expect(newsTime(published)).toBe("2026/11/18 21:35:22");
    expect(newsTimeShort(published)).toBe("11/18 21:35:22");
    expect(newsTime(Date.parse(published))).toBe("2026/11/18 21:35:22");
  });

  it("names the Beijing date when the instant crosses midnight UTC", () => {
    expect(newsTime("2026-11-18T17:05:09Z")).toBe("2026/11/19 01:05:09");
    expect(newsTimeShort("2026-11-18T17:05:09Z")).toBe("11/19 01:05:09");
    expect(newsTime("2026-11-18T16:00:00Z")).toBe("2026/11/19 00:00:00");
  });

  it("keeps publication and collection as independent moments", () => {
    const html = renderToStaticMarkup(
      createElement(
        "p",
        null,
        createElement(NewsTime, { value: published }),
        " · 采集：",
        createElement(NewsTime, { value: collected }),
      ),
    );
    expect(html).toContain(
      '<time dateTime="2026-11-18T13:35:22.000Z">2026/11/18 21:35:22</time>',
    );
    expect(html).toContain(
      '<time dateTime="2026-11-18T13:36:05.000Z">2026/11/18 21:36:05</time>',
    );
    expect(html).toContain("21:35:22</time> · 采集：");
  });

  it("uses month, day and seconds in buttons and the year in details", () => {
    expect(
      renderToStaticMarkup(
        createElement(NewsTime, { value: published, short: true }),
      ),
    ).toBe('<time dateTime="2026-11-18T13:35:22.000Z">11/18 21:35:22</time>');
    expect(
      renderToStaticMarkup(createElement(NewsTime, { value: published })),
    ).toBe(
      '<time dateTime="2026-11-18T13:35:22.000Z">2026/11/18 21:35:22</time>',
    );
  });

  it("keeps the existing placeholder for empty or invalid values", () => {
    for (const value of [null, undefined, "", "not-a-date", Number.NaN]) {
      expect(newsTime(value)).toBe(NEWS_TIME_FALLBACK);
      expect(newsTimeShort(value)).toBe(NEWS_TIME_FALLBACK);
      expect(newsTimeIso(value)).toBeUndefined();
    }
    expect(renderToStaticMarkup(createElement(NewsTime, { value: null }))).toBe(
      NEWS_TIME_FALLBACK,
    );
  });
});
