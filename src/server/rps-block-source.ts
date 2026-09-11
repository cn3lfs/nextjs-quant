import { industrySnapshotSchema } from "~/lib/industry-rps";
import { readIndustryBlocks } from "./industry-blocks";
import { readTdxLocalBlocks } from "./tdx-local-blocks";
import { rpsHash } from "./rps-engine";

/** One classification per ranking population; never mix parents and children. */
export async function readRpsBlockSource(
  options: { source: "blocks" | "tdx"; blocksRoot: string; tdxRoot: string },
  category: "industry" | "concept" = "industry",
  checkpoint: () => void = () => {},
) {
  if (options.source === "blocks")
    return readIndustryBlocks(options.blocksRoot, checkpoint, category);
  checkpoint();
  const snapshot = await readTdxLocalBlocks(options.tdxRoot);
  checkpoint();
  const classification =
    category === "industry" ? "tdx-research-level1" : "tdx-concept";
  const files = snapshot.blocks
    .filter(
      (block) =>
        block.category === category &&
        block.members.length > 0 &&
        (category !== "industry" || block.level === 1),
    )
    .map((block) => ({
      name: block.selectionName,
      file: block.code ?? block.selectionName,
      hash: rpsHash({ source: snapshot.hash, classification, block }),
      mtimeMs: Math.max(...snapshot.files.map((file) => file.mtimeMs)),
      members: block.members,
    }));
  return industrySnapshotSchema.parse({
    ...(category === "concept" ? { category } : {}),
    classification,
    sourceHash: snapshot.hash,
    root: snapshot.root,
    files,
    hash: rpsHash({ version: "tdx-rps-membership-1", classification, files }),
  });
}
