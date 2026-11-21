/**
 * `arc describe` prints each exported module's facts and invariant results — the same
 * evaluation boot runs — without booting anything.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describe as arcDescribe } from "../../src/cli/commands/describe.js";

async function runDescribe(entryContent: string): Promise<Record<string, unknown>> {
  const tempDir = await mkdtemp(join(tmpdir(), "arc-describe-modules-"));
  const entryPath = join(tempDir, "entry.mjs");
  await writeFile(entryPath, entryContent, "utf8");
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await arcDescribe([entryPath, "--json"]);
    return JSON.parse(logs.join("\n"));
  } finally {
    console.log = originalLog;
    await rm(tempDir, { recursive: true, force: true });
  }
}

const ENTRY = `
let bootstrapped = false;
export const media = {
  name: 'media',
  facts: { driver: 'local', uploadReceiver: false },
  invariants: [{
    code: 'media.upload-receiver',
    fix: 'enable the upload receiver or use a cloud driver',
    check: (f) => f.driver !== 'local' || f.uploadReceiver || 'local driver with the upload receiver off',
  }],
  bootstrap: () => { bootstrapped = true; throw new Error('describe must not boot'); },
};
export const modules = [
  media,
  {
    name: 'uploads',
    invariants: [{ code: 'uploads.media-present', fix: 'compose media', check: (_f, all) => all.media !== undefined }],
  },
  { name: 'plain' },
  () => ({ name: 'thunk', facts: { never: 'evaluated' } }),
];
export const wasBootstrapped = () => bootstrapped;
`;

describe("arc describe — module facts and invariants", () => {
  it("lists facts, invariant codes and results for exported modules, with no resources needed", async () => {
    const out = await runDescribe(ENTRY);
    expect(out.resources).toEqual([]);
    expect(out.modules).toEqual([
      {
        name: "media",
        facts: { driver: "local", uploadReceiver: false },
        invariants: [
          {
            code: "media.upload-receiver",
            fix: "enable the upload receiver or use a cloud driver",
            ok: false,
            reason: "local driver with the upload receiver off",
          },
        ],
      },
      {
        name: "uploads",
        facts: {},
        invariants: [{ code: "uploads.media-present", fix: "compose media", ok: true }],
      },
    ]);
  });
});
