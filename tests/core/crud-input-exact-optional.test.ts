/**
 * G-M1-1: a host compiled with `exactOptionalPropertyTypes` spreads `crudInput()` into
 * `defineResource()`. It reads arc's DECLARATIONS, not its source: an inferred return
 * type is emitted as `create?: { body } | undefined`, which that flag refuses. So this
 * test emits arc's declarations with arc's own settings, then compiles a consumer
 * against them with the flag on (`skipLibCheck`: only the consumer's diagnostics count).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
// Inside the repo so the emitted declarations resolve zod / fastify from node_modules.
const WORK = path.join(ROOT, "node_modules", ".cache", "arc-crud-input-exact");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

const CONSUMER = `
import { z } from "zod";
import { crudInput } from "./decl/core/routeInput.js";
import { defineResource } from "./decl/core/defineResource.js";
import { allowPublic } from "./decl/permissions/index.js";

const create = z.strictObject({ name: z.string() });
const update = z.strictObject({ name: z.string().optional() });
const adapter = undefined as never;
const permissions = {
  list: allowPublic(), get: allowPublic(), create: allowPublic(),
  update: allowPublic(), delete: allowPublic(),
};

export const both = defineResource({ name: "a", adapter, permissions, ...crudInput({ create, update }) });
export const updateOnly = defineResource({ name: "b", adapter, permissions, ...crudInput({ update }) });
export const parsedBoth = defineResource({
  name: "c", adapter, permissions, ...crudInput({ create, update, parse: true }),
});
`;

/** stdout + stderr of one tsc run ("" = clean). tsc may print diagnostics and still exit 0. */
function tsc(args: string[]): string {
  try {
    return execFileSync(process.execPath, [TSC, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || "tsc failed with no output";
  }
}

describe("crudInput under exactOptionalPropertyTypes (G-M1-1)", () => {
  beforeAll(() => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    const emitted = tsc([
      "-p",
      "tsconfig.json",
      "--noEmit",
      "false",
      "--emitDeclarationOnly",
      "--outDir",
      path.join(WORK, "decl"),
    ]);
    expect(emitted).toBe("");
    writeFileSync(path.join(WORK, "consumer.ts"), CONSUMER);
  }, 120_000);

  it("the declared return spreads into defineResource in a host with the flag on", () => {
    const out = tsc([
      path.join(WORK, "consumer.ts"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--exactOptionalPropertyTypes",
      "--skipLibCheck",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--types",
      "node",
    ]);
    // Any diagnostic fails, an option error included. `skipLibCheck` skips the emitted
    // declarations, so what is left is the consumer's own code.
    expect(out).toBe("");
  }, 120_000);
});
