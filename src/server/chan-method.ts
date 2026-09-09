import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const chanMethodVersion = "chan-annotation-3";
export const chanMethodFiles = [
  "SKILL.md",
  "references/02-morphology.md",
  "references/03-center-and-trend.md",
  "references/04-dynamics.md",
  "references/05-trading-points.md",
] as const;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export type ChanPassage = {
  id: string;
  file: string;
  line: number;
  heading: string;
  lessons: number[];
  quote: string;
};
function lessonNumbers(heading: string) {
  const lessons = new Set<number>();
  for (const match of heading.matchAll(/第([\d、/\-]+)课/g)) {
    for (const part of match[1]!.split(/[、/]/)) {
      const [start, end = start] = part.split("-").map(Number);
      if (!start || !end || start > end || end > 108) continue;
      for (let n = start; n <= end; n++) lessons.add(n);
    }
  }
  return [...lessons].sort((a, b) => a - b);
}

/** Only explicit blockquotes with a chapter/section lesson attribution are eligible. */
export function chanPassages(file: string, text: string): ChanPassage[] {
  const lines = text.split(/\r?\n/);
  const headings: { depth: number; title: string; lessons: number[] }[] = [];
  const passages: ChanPassage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[i]!);
    if (heading) {
      const depth = heading[1]!.length;
      while (headings.at(-1) && headings.at(-1)!.depth >= depth) headings.pop();
      headings.push({
        depth,
        title: heading[2]!,
        lessons: lessonNumbers(heading[2]!),
      });
      continue;
    }
    if (!/^>\s?/.test(lines[i]!)) continue;
    const line = i + 1;
    const block: string[] = [];
    while (i < lines.length && /^>\s?/.test(lines[i]!))
      block.push(lines[i++]!.replace(/^>\s?/, ""));
    i--;
    const lessons = [...headings]
      .reverse()
      .find((h) => h.lessons.length)?.lessons;
    const quote = block.join("\n").trim();
    if (!lessons?.length || !quote) continue;
    const content = {
      file,
      line,
      heading: headings.map((h) => h.title).join(" / "),
      lessons: [...lessons],
      quote,
    };
    passages.push({
      id: `chan-${hash(JSON.stringify(content)).slice(0, 16)}`,
      ...content,
    });
  }
  return passages;
}

export async function chanMethod() {
  const root = join(
    process.env.QUANT_SKILLS_DIR ?? join(homedir(), ".agent-skills", "skills"),
    "chan-theory",
  );
  const files = await Promise.all(
    chanMethodFiles.map(async (file) => {
      const text = await readFile(join(root, file), "utf8");
      return { file, hash: hash(text), text };
    }),
  );
  const passages = files.slice(1).flatMap((file) => {
    const entries = chanPassages(file.file, file.text);
    if (!entries.length)
      throw new Error(`缠论方法缺少可定位引文：${file.file}`);
    return entries;
  });
  if (new Set(passages.map((passage) => passage.id)).size !== passages.length)
    throw new Error("缠论引用标识冲突，无法生成报告");
  return {
    version: chanMethodVersion,
    source: "本机chan-theory课文整理资料，未逐字对照原博客",
    files: files.map(({ file, hash }) => ({ file, hash })),
    passages,
  };
}
