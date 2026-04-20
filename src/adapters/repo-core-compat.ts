/**
 * Compatibility gate — `@classytic/repo-core` ↔ Arc's `RepositoryLike`.
 *
 * **Type-level only.** Nothing is re-exported. Apps using repo-core install
 * `@classytic/repo-core` themselves and import directly from there. Arc's
 * `RepositoryLike` is now a *structural alias* of
 * `MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>`, so this gate is
 * primarily a documentation/visibility artifact — if the alias ever drifts
 * (e.g. an extension is re-added), `tsc --noEmit` catches it here.
 *
 * Repo-core is an OPTIONAL peer dep — apps without it never load this file.
 */

import type { MinimalRepo, StandardRepo } from "@classytic/repo-core/repository";
import type { RepositoryLike } from "./interface.js";

type AssertAssignable<Source, Target> = Source extends Target ? true : { __mismatch: Source };

/**
 * The repo-core standard contract MUST be structurally satisfied by Arc's
 * `RepositoryLike`. With the alias in `./interface.ts` this is tautology —
 * the gate stays as a canary against future regressions.
 */
type _Compat = AssertAssignable<
  MinimalRepo<unknown> & Partial<StandardRepo<unknown>>,
  RepositoryLike<unknown>
>;

const _REPO_CORE_COMPATIBLE: _Compat = true;
void _REPO_CORE_COMPATIBLE;
