/**
 * The three-layer page cap, and the one layer that can see the conflict.
 *
 * A parser, a repository's pagination engine and arc each cap page size, and
 * none can see the others — so the LOWEST wins silently. A resource declaring
 * 1000 against a repository left at its default 100 serves 100 rows with a 200:
 * an account picker read 100 of 696, filtered that arbitrary slice client-side,
 * and rendered "No accounts found".
 *
 * arc holds both the parser and the adapter, so it is the only layer that can
 * notice. A diagnostic, not a throw — the mismatch is usually an unconfigured
 * default, and the app does work, just less than its author intended.
 */

import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

/** Structural stand-ins — arc reads these shapes, never imports a kit. */
const parser = (maxLimit?: number) => ({ maxLimit, parse: () => ({}) }) as never;
const adapterWithRepoCap = (maxLimit?: number) =>
  ({
    repository: {
      ...(maxLimit === undefined ? {} : { _pagination: { config: { maxLimit } } }),
      create: async () => ({}),
      getAll: async () => [],
      getOne: async () => null,
      update: async () => null,
      delete: async () => null,
    },
  }) as never;

const diagnosticsOf = (r: ReturnType<typeof defineResource>) =>
  (r as unknown as { _diagnostics?: Array<{ code: string; message: string }> })._diagnostics ?? [];

const build = (parserCap?: number, repoCap?: number) =>
  defineResource({
    name: "account",
    adapter: adapterWithRepoCap(repoCap),
    queryParser: parser(parserCap),
    permissions: { list: allowPublic(), get: allowPublic() },
    disabledRoutes: ["create", "update", "delete"],
  });

describe("pagination cap mismatch", () => {
  it("warns when the parser allows more than the repository", () => {
    const codes = diagnosticsOf(build(1000, 100)).map((d) => d.code);
    expect(codes).toContain("pagination-cap-mismatch");
  });

  it("names BOTH numbers, so the fix needs no further digging", () => {
    const msg = diagnosticsOf(build(1000, 100)).find(
      (d) => d.code === "pagination-cap-mismatch",
    )?.message;
    expect(msg).toContain("1000");
    expect(msg).toContain("100");
  });

  it("stays quiet when the repository allows at least as much", () => {
    expect(diagnosticsOf(build(1000, 1000)).map((d) => d.code)).not.toContain(
      "pagination-cap-mismatch",
    );
  });

  it("stays quiet when the parser is the STRICTER of the two", () => {
    // The parser winning is not truncation-by-accident — it is the narrower
    // answer being honoured, which is the intended precedence.
    expect(diagnosticsOf(build(50, 100)).map((d) => d.code)).not.toContain(
      "pagination-cap-mismatch",
    );
  });

  it("skips a kit that exposes no pagination config, rather than guessing", () => {
    expect(diagnosticsOf(build(1000, undefined)).map((d) => d.code)).not.toContain(
      "pagination-cap-mismatch",
    );
  });

  it("skips a parser that declares no cap", () => {
    expect(diagnosticsOf(build(undefined, 100)).map((d) => d.code)).not.toContain(
      "pagination-cap-mismatch",
    );
  });
});
