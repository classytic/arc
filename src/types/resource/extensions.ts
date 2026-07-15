/**
 * `ResourceExtensions` — the typed plugin-extension namespace plugins
 * augment via declaration merging (`declare module "@classytic/arc/types"`).
 */

/**
 * Plugin extension namespace — arc's typed escape hatch for attaching
 * declarative, per-resource config that **plugins** read at request time.
 *
 * **External** plugins augment it via TypeScript declaration merging
 * (`declare module "@classytic/arc/types"`) to register their own typed
 * slice — exactly the model Fastify uses for `FastifyInstance` decorators.
 * The host gets full autocomplete + compile-time checking on the matching
 * `extensions` block, and a typo (`extensions: { encyrption: … }`) is a
 * type error rather than a silent no-op.
 *
 * **First-party** slices (arc's own subpath plugins) are declared inline
 * below with type-only imports instead of `declare module`. Not a style
 * choice: arc bundles its declarations, and a relative module augmentation
 * (`declare module "../types/resource.js"`) survives bundling as an
 * unresolvable specifier — the merge silently never happens for consumers,
 * so the key would be a compile ERROR downstream while working inside this
 * repo. Inline declaration is bundler-proof; the type-only import is erased
 * at runtime, so the plugin stays fully opt-in.
 *
 * **The "React for backend" composition model.** `defineResource()` is the
 * declarative component, `extensions` is its typed props bag, and plugins
 * are the providers that consume those props at the framework boundary.
 * Adding a cross-cutting capability becomes *additive* — a plugin ships a
 * subpath + a one-line `declare module` augmentation, with no new
 * first-class `ResourceConfig` field and no core release per feature.
 *
 * Arc threads the declared `extensions` onto every generated route's
 * Fastify `config` (see `createCrudRouter`), so a plugin reads its slice
 * at request time via `request.routeOptions.config.arcExtensions` without
 * re-deriving which resource a route belongs to.
 *
 * @example An external plugin package registers its slice
 * ```ts
 * declare module "@classytic/arc/types" {
 *   interface ResourceExtensions {
 *     myPlugin?: import("my-arc-plugin").MyPluginDirective;
 *   }
 * }
 * ```
 *
 * @example A host declares it on a resource
 * ```ts
 * defineResource({
 *   name: "payment",
 *   extensions: { encryption: { mode: "fields", fields: ["cardNumber", "cvv"] } },
 * });
 * ```
 */
export interface ResourceExtensions {
  /**
   * Encrypt this resource's responses — full-body JWE or specific fields.
   * Read at request time by `@classytic/arc/encryption`'s `encryptionPlugin`
   * from `request.routeOptions.config.arcExtensions.encryption`; inert (and
   * dependency-free — the import is type-only) unless that plugin is
   * registered.
   */
  encryption?: import("../../encryption/types.js").EncryptionDirective;
}
