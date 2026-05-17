/**
 * Read the host project's `.arcrc` (written at scaffold time by `arc init`)
 * and detect whether it's a TypeScript project via the presence of
 * `tsconfig.json`. Both checks degrade gracefully — a missing `.arcrc`
 * just means defaults, and the TS check uses the file marker rather than
 * inspecting `package.json` because the marker is what `tsx` / `tsc` also
 * key off.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArcProjectConfig } from "./types.js";

export function readProjectConfig(): ArcProjectConfig {
  try {
    const rcPath = join(process.cwd(), ".arcrc");
    return JSON.parse(readFileSync(rcPath, "utf-8")) as ArcProjectConfig;
  } catch {
    return {};
  }
}

export function isTypeScriptProject(): boolean {
  return existsSync(join(process.cwd(), "tsconfig.json"));
}
