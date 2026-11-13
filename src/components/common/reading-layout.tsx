"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Builds a directory from the actual rendered chapters, including async archives. */
export function ReadingLayout({ children }: { children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const sequence = useRef(0);
  const [chapters, setChapters] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    function readChapters() {
      const next = Array.from(node!.querySelectorAll<HTMLElement>("h2, h3"))
        .filter((heading) => !heading.closest("[hidden]"))
        .map((heading) => {
          if (!heading.id)
            heading.id = `chapter-${prefix}-${sequence.current++}`;
          return { id: heading.id, label: heading.textContent?.trim() ?? "" };
        })
        .filter((chapter) => chapter.label);
      setChapters((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    }
    readChapters();
    const observer = new MutationObserver(readChapters);
    observer.observe(node, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
    return () => observer.disconnect();
  }, [prefix]);
  return (
    <div className="nc-reading-layout">
      <nav aria-label="阅读目录" className="nc-reading-directory">
        <details open>
          <summary className="cursor-pointer text-sm font-medium">
            本页目录
          </summary>
          <div className="mt-3 flex flex-col gap-1">
            {chapters.map((chapter) => (
              <a
                key={chapter.id}
                href={`#${chapter.id}`}
                className="rounded px-2 py-1.5 text-[13px] text-nc-text-3 hover:bg-nc-inset focus-visible:outline-2 focus-visible:outline-nc-accent"
                onClick={(event) => {
                  const heading = document.getElementById(chapter.id);
                  if (!heading) return;
                  event.preventDefault();
                  heading.scrollIntoView({ block: "start" });
                  heading.tabIndex = -1;
                  heading.focus({ preventScroll: true });
                }}
              >
                {chapter.label}
              </a>
            ))}
            {!chapters.length && (
              <span className="text-[13px] text-nc-text-3">
                章节随正文载入。
              </span>
            )}
          </div>
        </details>
      </nav>
      <div
        ref={body}
        className="min-w-0 space-y-5 leading-7 [&_h2]:scroll-mt-20 [&_h3]:scroll-mt-20"
      >
        {children}
      </div>
    </div>
  );
}
