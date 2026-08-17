/**
 * `bin/arc.js` is the ONLY unbundled, untyped file arc ships — so nothing
 * else checks that the flags it advertises are the flags it parses.
 *
 * That gap shipped a real defect: `--api-key` was advertised in
 * `arc init --help`, declared on `InitOptions`, and prompted for
 * interactively — but `parseInitOptions` had no case for it. A CI/scripted
 * `arc init --better-auth --api-key --skip-install` printed
 * "unknown flag (ignored)" and scaffolded a project WITHOUT the plugin.
 * Non-interactive is exactly where nobody is watching the warning. Same for
 * `--session`.
 *
 * This asserts the two directions that matter:
 *   1. every long flag `--help` advertises is accepted by the parser;
 *   2. every flag the parser accepts is advertised somewhere in `--help`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../../bin/arc.js", import.meta.url));

function run(args: string[]): string {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

/** Long flags the parser has an explicit `case` for. */
function parsedFlags(): Set<string> {
  const src = readFileSync(BIN, "utf8");
  const body = src.slice(src.indexOf("function parseInitOptions"));
  return new Set([...body.matchAll(/case '(--[a-z-]+)'/g)].map((m) => m[1] as string));
}

/**
 * Long flags the INIT OPTIONS help block advertises — INCLUDING aliases
 * listed on the same line (`--multi-tenant, --multi`), which is why this
 * scans every token rather than line starts.
 */
function advertisedFlags(help: string): Set<string> {
  const block = help.slice(help.indexOf("INIT OPTIONS"), help.indexOf("GENERATE SUBCOMMANDS"));
  return new Set([...block.matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1] as string));
}

describe("bin/arc.js flag contract", () => {
  it("every advertised init flag is actually parsed", () => {
    const advertised = advertisedFlags(run(["--help"]));
    const parsed = parsedFlags();
    // `--help` is handled by the short-circuit in main(), not a parser case.
    const unwired = [...advertised].filter((f) => f !== "--help" && !parsed.has(f));
    expect(unwired, `advertised but silently ignored: ${unwired.join(", ")}`).toEqual([]);
  });

  it("every parsed init flag is advertised", () => {
    const advertised = advertisedFlags(run(["--help"]));
    const parsed = parsedFlags();
    const undocumented = [...parsed].filter((f) => f !== "--help" && !advertised.has(f));
    expect(undocumented, `parsed but undocumented: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("the two Better Auth flags that were missing are wired", () => {
    // Named explicitly so a regression on THESE reads as itself.
    const parsed = parsedFlags();
    expect(parsed.has("--api-key")).toBe(true);
    expect(parsed.has("--no-api-key")).toBe(true);
    expect(parsed.has("--session")).toBe(true);
  });

  it("`arc init --help` prints INIT usage, not the global manual", () => {
    // Regression: the global --help check scanned all of argv, so any
    // `arc <cmd> --help` printed the whole manual and COMMAND_HELP was
    // unreachable dead code.
    const out = run(["init", "--help"]);
    expect(out).toContain("Usage: arc init");
    expect(out).not.toContain("GENERATE SUBCOMMANDS"); // i.e. not the global help
  });

  it("`arc --help` still prints the global manual", () => {
    const out = run(["--help"]);
    expect(out).toContain("GENERATE SUBCOMMANDS");
  });

  it("`arc <command> --help` exits 0 for every documented command", () => {
    for (const cmd of ["init", "generate", "introspect", "describe", "docs", "doctor"]) {
      expect(() => run([cmd, "--help"]), `${cmd} --help`).not.toThrow();
    }
  });

  it("an unknown command exits NON-zero", () => {
    // Wrong usage must be scriptable — a 0 exit would make CI green on a typo.
    expect(() => execFileSync(process.execPath, [BIN, "nonsense"], { stdio: "pipe" })).toThrow();
  });

  it("uses process.exitCode, never process.exit() — piped output must not truncate", () => {
    // `process.exit()` races an async stdout flush on POSIX pipes, so
    // `arc describe --json > file` can lose its tail. Arc's `doctor` already
    // set exitCode; bin/arc.js did not.
    const src = readFileSync(BIN, "utf8");
    const code = src.replace(/^\s*\*.*$/gm, ""); // strip docblock lines
    expect(code).not.toMatch(/process\.exit\(/);
  });

  it("every misuse path exits 1, and success exits 0", () => {
    const fails = [["generate"], ["generate", "bogus", "x"], ["generate", "resource"], ["nope"]];
    for (const args of fails) {
      let code = 0;
      try {
        execFileSync(process.execPath, [BIN, ...args], { stdio: "pipe" });
      } catch (err) {
        code = (err as { status?: number }).status ?? -1;
      }
      expect(code, `arc ${args.join(" ")}`).toBe(1);
    }
    expect(() => run(["--version"])).not.toThrow();
  });

  it("--version prints the package version, exit 0", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(run(["--version"]).trim()).toBe(`Arc CLI v${pkg.version}`);
  });
});
