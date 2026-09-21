import { join } from "node:path";

export const DEV_ZINN_DIR = join(import.meta.dir, "..", ".zinn-dev");

export function selectDevelopmentDatabase() {
  process.env.ZINN_DIR = DEV_ZINN_DIR;
  return DEV_ZINN_DIR;
}
