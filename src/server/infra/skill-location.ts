import { homedir } from "node:os";
import { join } from "node:path";

/** Root of the user-installed shared skills (read at runtime, outside the bundle). */
export const skillsRoot = () =>
  process.env.QUANT_SKILLS_DIR ?? join(homedir(), ".agent-skills", "skills");

type Location = { dir: string; main: string };
const guide = (dir: string): Location => ({ dir, main: "GUIDE.md" });

/**
 * App method ids stay stable (they appear in stored research records and in the
 * frozen source lock). The shared skills were regrouped into role skills, so each
 * id that moved maps to the folder that now holds its method and to its main file
 * (the folded method's GUIDE.md instead of SKILL.md).
 */
const moved: Record<string, Location> = {
  "swing-trader": guide("technical-analyst/references/dual-breakout"),
  "wyckoff-trader": guide("technical-analyst/references/wyckoff"),
  "chan-theory": guide("technical-analyst/references/chan"),
  "volume-price-analysis": guide("technical-analyst/references/volume-price"),
  "opening-price-playbook": guide("technical-analyst/references/opening"),
  "canslim-analyst": guide("growth-stock-strategist/references/canslim"),
  "sepa-strategy-analyst": guide("growth-stock-strategist/references/sepa"),
  "technical-toolkit": {
    dir: "technical-analyst/references/toolkit",
    main: "indicators.md",
  },
  "stop-loss": { dir: "risk-manager", main: "SKILL.md" },
  "astock-market-rules": {
    dir: "risk-manager/references",
    main: "astock-rules.md",
  },
  "market-sentiment-analyst": guide("market-analyst/references/temperature"),
  "tmt-crowding": guide("market-analyst/references/tmt-crowding"),
  "message-analyst": guide("event-researcher/references/message"),
  "industry-chain-analyst": guide("event-researcher/references/industry-chain"),
  "guo-yongqing-valuation": guide(
    "fundamental-analyst/references/guo-yongqing",
  ),
  "value-investing": guide("fundamental-analyst/references/value-investing"),
  "announcement-search": guide("hithink-wencai/references/announcement-search"),
  "news-search": guide("hithink-wencai/references/news-search"),
  "report-search": guide("hithink-wencai/references/report-search"),
  "gf-etf-rank": guide("gf-data/references/etf-rank"),
  "gf-lhb": guide("gf-data/references/lhb"),
  "gf-quant": guide("gf-data/references/financials"),
  "gf-windmill": guide("gf-data/references/index-valuation"),
};

function locate(skillId: string): Location {
  if (moved[skillId]) return moved[skillId];
  if (skillId.startsWith("hithink-") && skillId !== "hithink-wencai")
    return guide(
      `hithink-wencai/references/${skillId.slice("hithink-".length)}`,
    );
  return { dir: skillId, main: "SKILL.md" };
}

/**
 * Absolute path of a file that belongs to an app method id. `file` is relative to
 * the method's own folder as the app has always named it: "SKILL.md" means the
 * method's main file, "references/x.md" a file beside it. A leading "../<id>/..."
 * names a file of another method id and is resolved through the same mapping.
 */
export function skillFile(skillId: string, file = "SKILL.md"): string {
  if (file.startsWith("../")) {
    const rest = file.slice(3),
      slash = rest.indexOf("/");
    return skillFile(rest.slice(0, slash), rest.slice(slash + 1));
  }
  const { dir, main } = locate(skillId);
  return join(skillsRoot(), dir, file === "SKILL.md" ? main : file);
}

/** Folder that holds an app method id's files. */
export function skillDirectory(skillId: string): string {
  return join(skillsRoot(), locate(skillId).dir);
}
