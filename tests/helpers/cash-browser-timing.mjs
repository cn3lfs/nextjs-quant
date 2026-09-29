/** Measure the dispatched click to the first painted, usable result. Playwright's
 * scrolling/stability checks and locator polling are reported separately by the
 * caller; they are not application input latency. No application state is altered.
 */
export async function armCashTiming(page, expected) {
  await page.evaluate((expected) => {
    const table = () =>
      document.querySelector('section[aria-label="逐日现金核对"]');
    const detail = () =>
      document.querySelector('section[aria-label="现金核对详情"]');
    const ready = () => {
      if (expected.kind === "filter")
        return (
          document
            .querySelector('section[aria-label="现金核对"]')
            ?.textContent.includes(`当前筛选匹配 ${expected.count} 天`) &&
          table()?.closest("fieldset")?.disabled === false
        );
      if (expected.kind === "page")
        return (
          table()?.querySelector("tbody button")?.textContent ===
            expected.date && table()?.closest("fieldset")?.disabled === false
        );
      if (expected.kind === "back") return !detail() && !!table();
      if (expected.kind === "date")
        return (
          detail()?.textContent.includes(expected.date) &&
          [...(detail()?.querySelectorAll("li") ?? [])].some(
            (item) =>
              item.textContent.includes("cash-pressure-large") &&
              item.querySelector("button"),
          )
        );
      return (
        document.querySelectorAll(
          'section[aria-label="结构化余额证据"] tbody tr',
        ).length === 20
      );
    };
    globalThis.cashTiming = { start: null, ms: null };
    let pending = false;
    const check = () => {
      if (globalThis.cashTiming.start === null || pending || !ready()) return;
      pending = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          pending = false;
          if (!ready()) return;
          globalThis.cashTiming.ms =
            performance.now() - globalThis.cashTiming.start;
          observer.disconnect();
        }),
      );
    };
    const observer = new MutationObserver(check);
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    document.addEventListener(
      "click",
      () => {
        globalThis.cashTiming.start = performance.now();
        requestAnimationFrame(check);
      },
      { once: true, capture: true },
    );
  }, expected);
}
export async function cashTiming(page) {
  await page.waitForFunction(() => globalThis.cashTiming.ms !== null);
  return page.evaluate(() => globalThis.cashTiming.ms);
}
