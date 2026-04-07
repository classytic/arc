/**
 * Better Auth × Mongoose Bridge
 *
 * Optional helper that registers stub Mongoose models for the collections
 * that Better Auth's MongoDB adapter writes to. This is a one-way *read*
 * bridge: Better Auth still writes via its own native `mongodb` driver
 * (through `@better-auth/mongo-adapter`), but stub models let arc resources
 * built on Mongoose use `.populate()` against BA-owned collections.
 *
 * **Why this is needed**: Mongoose's `populate()` looks up the target model
 * by name. BA never registers anything with Mongoose, so a schema like
 * `new Schema({ userId: { ref: 'user' } })` throws `MissingSchemaError`
 * the first time you call `.populate('userId')`. This helper registers an
 * empty `strict: false` schema for each BA collection, so populate works
 * without interfering with BA's writes.
 *
 * **DB-agnostic by design**: this file lives at the dedicated subpath
 * `@classytic/arc/auth/mongoose`. Users on Prisma/Drizzle/Kysely never
 * import it and never get Mongoose pulled into their bundle. Mongoose is
 * passed in as a parameter so this module has zero runtime imports of it.
 *
 * @example
 * ```ts
 * import mongoose from 'mongoose';
 * import { betterAuth } from 'better-auth';
 * import { mongodbAdapter } from '@better-auth/mongo-adapter';
 * import { organization } from 'better-auth/plugins';
 * import { registerBetterAuthMongooseModels } from '@classytic/arc/auth/mongoose';
 *
 * const auth = betterAuth({
 *   database: mongodbAdapter(mongoose.connection.getClient().db()),
 *   plugins: [organization({ teams: { enabled: true } })],
 *   // ...
 * });
 *
 * // Register stub models AFTER betterAuth() so collections are known.
 * // For plugins shipped as separate @better-auth/* packages (passkey, sso,
 * // api-key, oauth-provider, etc.), add their collection names via
 * // `extraCollections` — see the JSDoc on that option for known names.
 * registerBetterAuthMongooseModels(mongoose, {
 *   plugins: ['organization', 'organization-teams', 'mcp'],
 *   extraCollections: ['passkey', 'ssoProvider'], // @better-auth/passkey, @better-auth/sso
 * });
 *
 * // Now an arc resource can populate BA-owned references:
 * const PostSchema = new mongoose.Schema({
 *   title: String,
 *   authorId: { type: String, ref: 'user' },
 * });
 * const Post = mongoose.model('Post', PostSchema);
 * await Post.findOne().populate('authorId'); // resolves against BA's user collection
 * ```
 */

/**
 * Minimal structural type for the subset of Mongoose we touch.
 * Declared structurally so this file has zero `import` of mongoose —
 * mongoose stays a peer dep and is never bundled with arc.
 */
export interface MongooseLike {
  models: Record<string, unknown>;
  Schema: new (
    definition: Record<string, unknown>,
    options?: { strict?: boolean; collection?: string; _id?: boolean },
  ) => unknown;
  model: (name: string, schema?: unknown) => unknown;
}

/**
 * Plugin keys that map to Better Auth collection sets.
 *
 * Only plugins that ship inside the **core `better-auth` package** are listed
 * here. Plugins distributed as separate `@better-auth/*` packages
 * (api-key, passkey, sso, oauth-provider, etc.) evolve independently and
 * should be handled via `extraCollections` — see the JSDoc on that option.
 *
 * Plugins that only add *fields* to existing tables (admin, username,
 * phoneNumber, magicLink, emailOtp, anonymous, bearer, multiSession, siwe,
 * lastLoginMethod, genericOAuth, etc.) don't need an entry here — the stub
 * schemas are registered with `strict: false`, so extra fields round-trip
 * automatically.
 *
 * - `core` — always included; covers `user`, `session`, `account`, `verification`.
 * - `organization` — adds `organization`, `member`, `invitation`.
 * - `organization-teams` — adds `team`, `teamMember` (only when `teams.enabled`).
 * - `twoFactor` — adds `twoFactor`.
 * - `jwt` — adds `jwks`.
 * - `oidcProvider` — adds `oauthApplication`, `oauthAccessToken`, `oauthConsent`.
 * - `oauthProvider` — alias of `oidcProvider` (same schema). Use this key if
 *   you've migrated to `@better-auth/oauth-provider` per BA 1.6 release notes
 *   — the collections are identical.
 * - `mcp` — MCP plugin **reuses the oidcProvider schema** (docs: "The MCP
 *   plugin uses the same schema as the OIDC Provider plugin"). Selecting this
 *   registers the oauth* collections.
 * - `deviceAuthorization` — adds `deviceCode` (RFC 8628 device authorization).
 */
export type BetterAuthPluginKey =
  | "core"
  | "organization"
  | "organization-teams"
  | "twoFactor"
  | "jwt"
  | "oidcProvider"
  | "oauthProvider"
  | "mcp"
  | "deviceAuthorization";

const COLLECTIONS_BY_PLUGIN: Record<BetterAuthPluginKey, readonly string[]> = {
  core: ["user", "session", "account", "verification"],
  organization: ["organization", "member", "invitation"],
  "organization-teams": ["team", "teamMember"],
  twoFactor: ["twoFactor"],
  jwt: ["jwks"],
  oidcProvider: ["oauthApplication", "oauthAccessToken", "oauthConsent"],
  // oauthProvider and mcp reuse the oidcProvider schema exactly (docs explicit).
  oauthProvider: ["oauthApplication", "oauthAccessToken", "oauthConsent"],
  mcp: ["oauthApplication", "oauthAccessToken", "oauthConsent"],
  deviceAuthorization: ["deviceCode"],
};

export interface RegisterBetterAuthMongooseModelsOptions {
  /**
   * Which Better Auth plugin collection sets to register stubs for.
   * `'core'` is always included implicitly (covers `user`, `session`,
   * `account`, `verification`).
   *
   * **Default is `[]` (core only) on purpose** — the helper should never
   * register stubs for plugins you haven't enabled. Opt in explicitly to
   * each plugin you've added to your `betterAuth({ plugins: [...] })` config.
   *
   * @default []
   * @example
   * ```ts
   * // Just core BA (email/password, sessions)
   * registerBetterAuthMongooseModels(mongoose);
   *
   * // Core + organization plugin
   * registerBetterAuthMongooseModels(mongoose, { plugins: ['organization'] });
   *
   * // Core + organization with teams + MCP server
   * registerBetterAuthMongooseModels(mongoose, {
   *   plugins: ['organization', 'organization-teams', 'mcp'],
   * });
   * ```
   */
  plugins?: BetterAuthPluginKey[];
  /**
   * Whether Better Auth's mongo adapter was configured with `usePlural: true`.
   * When true, model names and collection names are pluralized
   * (`user` → `users`, `organization` → `organizations`, etc).
   *
   * **Must match** the `usePlural` value passed to `mongodbAdapter()`.
   *
   * @default false
   */
  usePlural?: boolean;
  /**
   * Override the model name for specific Better Auth collections.
   * Use this when you've passed `user: { modelName: 'profiles' }` (or similar)
   * to `betterAuth()` — pass the same map here so populate names line up.
   *
   * Keys are the canonical BA names (`user`, `session`, etc.); values are
   * the model name to register with Mongoose. The collection name is also
   * set to the override value.
   *
   * @example
   * ```ts
   * registerBetterAuthMongooseModels(mongoose, {
   *   modelOverrides: { user: 'profile', member: 'orgMember' },
   * });
   * ```
   */
  modelOverrides?: Partial<Record<string, string>>;
  /**
   * Additional collection names to register beyond the built-in plugin set.
   *
   * **Use this for plugins that ship as separate `@better-auth/*` packages**
   * (they're intentionally not hardcoded in `BetterAuthPluginKey` because
   * their collection names live in their own packages and can evolve
   * independently of the core `better-auth` release cycle).
   *
   * Known collection names for official separate-package plugins:
   * - `@better-auth/passkey` → `'passkey'`
   * - `@better-auth/sso` → `'ssoProvider'`
   * - `@better-auth/oauth-provider` → already covered by `plugins: ['oauthProvider']`
   *   (same schema as the in-core `oidcProvider`)
   * - `@better-auth/api-key` → consult the plugin's docs for the current
   *   model name; it's one collection
   *
   * For your own custom Better Auth plugins, pass whatever collection names
   * they write to.
   *
   * @default []
   * @example
   * ```ts
   * registerBetterAuthMongooseModels(mongoose, {
   *   plugins: ['organization'],
   *   extraCollections: ['passkey', 'ssoProvider'],
   * });
   * ```
   */
  extraCollections?: string[];
}

/**
 * Naive English pluralization that matches Better Auth's `usePlural` behavior.
 * BA's mongo adapter just appends `s` (it doesn't handle irregular nouns —
 * none of its collection names are irregular). We mirror that exactly.
 */
function pluralize(name: string): string {
  return name.endsWith("s") ? name : `${name}s`;
}

/**
 * Register stub Mongoose models for Better Auth's collections so that
 * Mongoose-based arc resources can `.populate()` references to BA-owned
 * documents. Idempotent — safe to call multiple times.
 *
 * Returns the list of model names that were newly registered (excluding
 * any that already existed on `mongoose.models`).
 */
export function registerBetterAuthMongooseModels(
  mongoose: MongooseLike,
  options: RegisterBetterAuthMongooseModelsOptions = {},
): string[] {
  const { plugins = [], usePlural = false, modelOverrides = {}, extraCollections = [] } = options;

  // 'core' is always implied
  const pluginSet = new Set<BetterAuthPluginKey>(["core", ...plugins]);

  const collected: string[] = [];
  for (const key of pluginSet) {
    for (const name of COLLECTIONS_BY_PLUGIN[key]) {
      collected.push(name);
    }
  }
  for (const name of extraCollections) {
    collected.push(name);
  }

  // De-duplicate while preserving order (organization-teams + organization
  // share no overlap, but extraCollections might collide with built-ins).
  const seen = new Set<string>();
  const unique = collected.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));

  const registered: string[] = [];
  for (const canonical of unique) {
    const overridden = modelOverrides[canonical];
    const finalName = overridden ?? (usePlural ? pluralize(canonical) : canonical);

    if (mongoose.models[finalName]) continue;

    const schema = new mongoose.Schema({}, { strict: false, collection: finalName, _id: false });
    mongoose.model(finalName, schema);
    registered.push(finalName);
  }

  return registered;
}
