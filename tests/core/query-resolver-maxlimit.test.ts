/**
 * A parser's own page cap must WIN over the framework default.
 *
 * Three layers each capped independently and the lowest won silently: a resource wrote
 * `new QueryParser({ maxLimit: 1000 })`, the repository was configured for 1000, and
 * `QueryResolver` applied its own default of 100 on top. Result — a chart-of-accounts
 * picker received 100 of 696 rows, filtered that arbitrary slice client-side, and
 * rendered "No accounts found" against a full database. Nothing errored.
 *
 * A resource that declares a cap has ANSWERED the question. Overriding it downstream is
 * not a safety net; it is a second opinion nobody can see.
 */
import { describe, expect, it } from "vitest";
import { BaseCrudController } from "../../src/core/BaseCrudController.js";
import { QueryResolver } from "../../src/core/QueryResolver.js";

/** Minimal parser exposing a cap, as mongokit's QueryParser now does. */
const parserWithCap = (maxLimit?: number) => ({
  maxLimit,
  parse: (q: Record<string, unknown> | null | undefined) => ({ filter: {}, ...(q ?? {}) }) as never,
});

/** Read the resolver's effective cap without depending on private state. */
const capOf = (r: QueryResolver) => (r as unknown as { maxLimit: number }).maxLimit;

describe("QueryResolver max-limit precedence", () => {
  it("DEFERS to the parser's cap when one is declared", () => {
    expect(capOf(new QueryResolver({ queryParser: parserWithCap(1000) as never }))).toBe(1000);
  });

  it("explicit config still wins over the parser", () => {
    // The host asked for something specific; that outranks a package default.
    expect(
      capOf(new QueryResolver({ queryParser: parserWithCap(1000) as never, maxLimit: 50 })),
    ).toBe(50);
  });

  it("falls back to 100 when the parser declares no cap", () => {
    // Unchanged behaviour for every parser that does not opt in.
    expect(capOf(new QueryResolver({ queryParser: parserWithCap(undefined) as never }))).toBe(100);
  });

  it("falls back to 100 with no parser at all", () => {
    expect(capOf(new QueryResolver())).toBe(100);
  });

  it("honours a parser cap SMALLER than the default", () => {
    // Deference is not "take the larger" — the parser is authoritative either way.
    expect(capOf(new QueryResolver({ queryParser: parserWithCap(25) as never }))).toBe(25);
  });

  /**
   * The case the constructor-only fix missed.
   *
   * `setQueryParser()` mutates the resolver in place so captured refs stay valid, which
   * means most resources supply their parser HERE rather than through the constructor.
   * Deferring only at construction passed every unit test and changed nothing at
   * runtime — the chart of accounts still served 100 of 696 rows.
   */
  it("adopts the cap of a parser swapped in via setParser", () => {
    const r = new QueryResolver();
    expect(capOf(r)).toBe(100);

    r.setParser(parserWithCap(1000) as never);
    expect(capOf(r)).toBe(1000);
  });

  it("an EXPLICIT config cap still wins over a swapped-in parser", () => {
    // A host decision outranks a package default, whenever the parser arrives.
    const r = new QueryResolver({ maxLimit: 50 });
    r.setParser(parserWithCap(1000) as never);
    expect(capOf(r)).toBe(50);
  });

  it("keeps its cap when the swapped parser declares none", () => {
    const r = new QueryResolver({ queryParser: parserWithCap(300) as never });
    r.setParser(parserWithCap(undefined) as never);
    expect(capOf(r)).toBe(300);
  });
});

/**
 * The controller must not launder its own default into an explicit one.
 *
 * `BaseCrudController` used to set `maxLimit = options.maxLimit ?? 100` and pass
 * that down, so `QueryResolver` could not distinguish "the host chose 100" from
 * "nobody said anything" — and the parser's own cap, the only party that
 * actually knew the resource was a bounded catalog, could never win. A chart of
 * accounts declaring 1000 served 100 rows of 696 with a `200` and no warning.
 *
 * Precedence asserted here, not just the number: host > parser > framework floor.
 */
describe("BaseCrudController — maxLimit precedence", () => {
  const parserWith = (maxLimit?: number) =>
    ({ maxLimit, parse: (q: Record<string, unknown>) => q }) as never;

  const ctl = (options: Record<string, unknown>) =>
    new BaseCrudController({} as never, options as never) as unknown as {
      maxLimit: number;
    };

  it("adopts the parser's cap when the host states none", () => {
    expect(ctl({ queryParser: parserWith(1000) }).maxLimit).toBe(1000);
  });

  it("the host's explicit cap still outranks the parser", () => {
    expect(ctl({ queryParser: parserWith(1000), maxLimit: 25 }).maxLimit).toBe(25);
  });

  it("falls back to the framework floor when neither states one", () => {
    expect(ctl({ queryParser: parserWith(undefined) }).maxLimit).toBe(100);
  });
});
