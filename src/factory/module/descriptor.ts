/**
 * Resolved module introspection — what a module ACTUALLY composed to.
 *
 * `ArcModule` is the authoring shape: `resources` may be an array or a factory,
 * `owns` may be a list or `"provided"`, and neither tells you what the module
 * ended up mounting. Consumers that needed the resolved answer were reduced to
 * inspecting that shape — a downstream conformance suite had to treat every
 * resource FACTORY as a violation, because it could not distinguish "late-bound
 * and legitimate" from "unresolvable", and so rejected valid modules.
 *
 * A descriptor is the resolved, read-only answer, published after arc has done
 * the work exactly once. It lets tooling assert on the real graph without
 * touching arc internals:
 *
 *   - conformance suites verify what a module provides and supersedes;
 *   - `doctor` surfaces duplicate resources and unmet dependencies;
 *   - tests assert the composed graph instead of re-deriving it;
 *   - operators inspect a large installation;
 *   - documentation generators read one stable contract.
 *
 * Deliberately DATA — no functions, no live handles. It survives
 * `structuredClone`, so it can cross a worker boundary or be written to a file
 * as-is, and holding one cannot keep a closed app alive.
 */

/** One resource as arc resolved it. */
export interface ResolvedResourceDescriptor {
  /** Resource name; absent for an anonymous resource (participates in no dedup). */
  readonly name?: string;
  /** Route prefix, when the resource declared one. */
  readonly prefix?: string;
  /** Whether the resource opted out of the app-wide `resourcePrefix`. */
  readonly skipGlobalPrefix: boolean;
}

/** Lifecycle surface a module ended up with — counts, not handles. */
export interface ResolvedModuleLifecycle {
  /** Does the module tear anything down? */
  readonly hasClose: boolean;
  /** Event-handler subscriptions arc owns for this module. */
  readonly subscriptions: number;
  /** Recurring schedules contributed. */
  readonly scheduledJobs: number;
  /** Readiness checks contributed. */
  readonly healthChecks: number;
  /** Whether the module contributed a public export at `arc.modules[name]`. */
  readonly exports: boolean;
}

/** The resolved, read-only description of one composed module. */
export interface ResolvedModuleDescriptor {
  readonly name: string;
  /** Declared composition edges, in the order the module listed them. */
  readonly dependsOn: readonly string[];
  /** Resources this module actually mounted, in registration order. */
  readonly resources: readonly ResolvedResourceDescriptor[];
  /**
   * The EFFECTIVE supersession list — already derived when the module declared
   * `owns: "provided"`, so callers never re-implement that resolution.
   */
  readonly owns: readonly string[];
  readonly lifecycle: ResolvedModuleLifecycle;
}

/** Minimal resource shape the descriptor reads. Structural — matches `ResourceLike`. */
interface DescribableResource {
  readonly name?: string | undefined;
  readonly prefix?: string | undefined;
  readonly skipGlobalPrefix?: boolean | undefined;
}

/**
 * Build a descriptor. Called by `registerResources` once per module, after
 * resources are resolved and `owns` is effective.
 *
 * Frozen at every level: a descriptor is a snapshot of a completed decision,
 * and a consumer mutating it would silently disagree with the running app.
 */
export function describeResolvedModule(input: {
  readonly name: string;
  readonly dependsOn?: readonly string[] | undefined;
  readonly resources: readonly DescribableResource[];
  readonly owns: readonly string[];
  readonly lifecycle: ResolvedModuleLifecycle;
}): ResolvedModuleDescriptor {
  return Object.freeze({
    name: input.name,
    dependsOn: Object.freeze([...(input.dependsOn ?? [])]),
    resources: Object.freeze(
      input.resources.map((r) =>
        Object.freeze({
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.prefix !== undefined ? { prefix: r.prefix } : {}),
          skipGlobalPrefix: r.skipGlobalPrefix === true,
        }),
      ),
    ),
    owns: Object.freeze([...input.owns]),
    lifecycle: Object.freeze({ ...input.lifecycle }),
  });
}
