import { isAbsolute, resolve } from "node:path";

// This side-effect import must precede application imports in each study CLI.
const directory = process.env.QUANT_DATA_DIR;
if (
  !directory ||
  !isAbsolute(directory) ||
  resolve(directory) !== resolve(".test-data/r2a3/data")
)
  throw new Error(
    "Set absolute isolated QUANT_DATA_DIR=.test-data/r2a3/data before loading research application modules",
  );
