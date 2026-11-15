import { isAbsolute, resolve } from "node:path";
const directory = process.env.QUANT_DATA_DIR;
if (
  !directory ||
  !isAbsolute(directory) ||
  resolve(directory) !== resolve(".test-data/r2a4/data")
)
  throw new Error(
    "Set absolute isolated QUANT_DATA_DIR=.test-data/r2a4/data before loading research modules",
  );
