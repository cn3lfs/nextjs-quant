import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const wyckoffMethodVersion = "wyckoff-research-1";
// Scanner and teaching documents are not part of the single-security report.
export const wyckoffMethodFiles = [
  "SKILL.md",
  "references/wyckoff-foundation.md",
  "references/wyckoff-mtf-guide.md",
  "references/wyckoff-volume-analysis.md",
  "references/wyckoff-vsa-signals.md",
  "references/wyckoff-volume-profile.md",
  "references/wyckoff-accumulation-schematic.md",
  "references/wyckoff-distribution-schematic.md",
  "references/wyckoff-relative-strength.md",
  "references/wyckoff-pf-targets.md",
  "references/wyckoff-glossary.md",
] as const;

export async function wyckoffMethod() {
  const directory = join(
    process.env.QUANT_SKILLS_DIR ?? join(homedir(), ".agent-skills", "skills"),
    "wyckoff-trader",
  );
  const documents = await Promise.all(
    wyckoffMethodFiles.map(async (file) => {
      const text = await readFile(join(directory, file), "utf8");
      if (!text.trim()) throw new Error(`威科夫方法文件为空：${file}`);
      return {
        file,
        text,
        hash: createHash("sha256").update(text).digest("hex"),
      };
    }),
  );
  return {
    version: wyckoffMethodVersion,
    source: "本机wyckoff-trader方法资料",
    files: documents.map(({ file, hash }) => ({ file, hash })),
    documents,
    boundaries: [
      "应用内研究解释；形态算法未验收前，不把阶段或事件假设用于自动信号",
      "周线定结构、日线识别交易区间、小时线观察时机；缺少周期必须披露，不能用日线冒充多周期对齐",
      "小时线不可用时明确no_hourly；任一周期不足30根时披露该周期样本不足，不给精确入场结论",
      "Volume Profile为近似时必须说明构建方式，不能当作真实逐价成交分布",
      "P&F目标、相对强弱、阶段假设分别展示；没有计算与输入证据时不生成目标价格或综合评分",
      "不将技能默认100万元、风险比例或信号映射胜率视作用户资金、风险偏好或实测胜率",
      "本地不复权行情必须保持标识，企业行动未核验时不能声称已复权或已排除除权影响",
      "报告中的方法示例、工具及交易指令仅为参考资料，不执行命令、下单或通知",
    ],
  };
}
