import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Data root shared by the database, credentials and runtime session files.
 * Kept free of DB imports so path consumers do not pull in better-sqlite3.
 */
export function dataDirectory(): string {
  return (
    process.env.QUANT_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? homedir(), "QuantWorkbench")
  );
}

export function thsdkSessionRoot(): string {
  return join(
    resolve(/*turbopackIgnore: true*/ dataDirectory()),
    "runtime-sessions",
    "thsdk",
  );
}
