/**
 * Filter dialects — decouple `ArcQueryParser` from any single datastore's
 * operator vocabulary.
 *
 * The parser owns everything store-INDEPENDENT: URL parsing, field/operator
 * whitelisting, depth limits, value coercion, ReDoS-safe regex sanitisation.
 * A `FilterDialect` owns the ONLY store-specific part of the output — which
 * token each neutral operator (`gte`, `like`, `in`, …) is emitted as, and how a
 * case-insensitive text match is expressed. Swap the dialect (or the whole
 * parser via `QueryParserInterface`) to target a non-Mongo store; the default
 * stays Mongo, so existing hosts are unaffected.
 */

export interface FilterDialect {
  /**
   * Neutral operator name → emitted token. An operator absent from this map is
   * treated as unsupported (dropped), so a dialect also defines its operator set.
   */
  readonly operators: Readonly<Record<string, string>>;
  /**
   * Extra keys merged into a field-filter when a documented case-insensitive
   * text operator (`like` / `contains`) is used. Mongo expresses this as a
   * sibling `{ $options: 'i' }`; a dialect that encodes case-insensitivity in
   * the operator itself returns `{}`.
   */
  caseInsensitiveModifier(): Record<string, unknown>;
}

/**
 * Default dialect — MongoDB / MongoKit operator shape. Emits `$`-prefixed
 * tokens and the `$options: 'i'` case-insensitive sibling. This is what
 * `ArcQueryParser` uses when no dialect is supplied, so behaviour is identical
 * to every prior arc version.
 */
export const MONGO_DIALECT: FilterDialect = {
  operators: {
    eq: "$eq",
    ne: "$ne",
    gt: "$gt",
    gte: "$gte",
    lt: "$lt",
    lte: "$lte",
    in: "$in",
    nin: "$nin",
    like: "$regex",
    contains: "$regex",
    regex: "$regex",
    exists: "$exists",
  },
  caseInsensitiveModifier: () => ({ $options: "i" }),
};

/**
 * Store-neutral reference dialect — emits UN-prefixed operator tokens as a
 * translation AST (`?price[gte]=40` → `{ price: { gte: 40 } }`, with
 * `{ caseInsensitive: true }` for `like`/`contains`). A non-Mongo adapter can
 * consume this directly instead of writing a full `QueryParserInterface`. Use
 * as a starting point; adjust the token names to your store's vocabulary.
 */
export const NEUTRAL_DIALECT: FilterDialect = {
  operators: {
    eq: "eq",
    ne: "ne",
    gt: "gt",
    gte: "gte",
    lt: "lt",
    lte: "lte",
    in: "in",
    nin: "nin",
    like: "like",
    contains: "contains",
    regex: "regex",
    exists: "exists",
  },
  caseInsensitiveModifier: () => ({ caseInsensitive: true }),
};
