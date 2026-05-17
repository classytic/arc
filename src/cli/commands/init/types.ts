/**
 * Shared types for the `arc init` scaffolder.
 *
 * `InitOptions` is the public CLI surface (everything callers can pass);
 * `ProjectConfig` is the post-prompt resolved shape every template
 * consumes. Keeping them separate lets the CLI surface evolve (more
 * optional flags) without forcing every template to inspect optionality.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface InitOptions {
  name?: string;
  adapter?: "mongokit" | "custom";
  auth?: "jwt" | "better-auth";
  tenant?: "multi" | "single";
  /**
   * Enable Better Auth's `apiKey` plugin (`@better-auth/api-key`) for
   * machine-to-machine authentication alongside cookie/session auth.
   * Only used when `auth === 'better-auth'`. Default: false.
   */
  apiKey?: boolean;
  /**
   * Session strategy when using Better Auth.
   * - `cookie` (default): browser cookie + DB-backed session (BA's default)
   * - `bearer`: Authorization: Bearer header (mobile apps, SPA, M2M)
   * Both can coexist — `bearer: true` adds bearer alongside cookies.
   */
  session?: "cookie" | "bearer" | "both";
  typescript?: boolean;
  edge?: boolean;
  /**
   * Emit Dockerfile / .dockerignore / docker-compose.yml in the scaffold.
   *
   * 2.16: defaults to `false`. Docker / deployment topology is an
   * app-level concern — many hosts ship to Cloud Run / Fly / Vercel /
   * AWS Lambda / Cloudflare Workers / their own Kubernetes manifests
   * and don't want arc's opinionated Docker assets cluttering the repo
   * (the framework rule is "don't dictate deployment"). Opt in with
   * `--docker` when you genuinely want arc's Compose-based dev setup.
   *
   * `edge: true` continues to imply no Docker (Workers don't run in
   * containers) — the flag is ignored when `edge` is set.
   */
  docker?: boolean;
  skipInstall?: boolean;
  force?: boolean;
}

export interface ProjectConfig {
  name: string;
  adapter: "mongokit" | "custom";
  auth: "jwt" | "better-auth";
  tenant: "multi" | "single";
  apiKey: boolean;
  session: "cookie" | "bearer" | "both";
  typescript: boolean;
  edge: boolean;
  /** Resolved opt-in for Docker scaffolding — see `InitOptions.docker`. */
  docker: boolean;
}

export interface DependencyManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}
