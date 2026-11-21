/**
 * One shape for every boot failure arc detects from configuration: a stable
 * `code`, the module it belongs to (when one does), what is wrong, and a
 * one-line `fix`. Codes are kebab-case like resource diagnostics
 * (`crud-public-by-omission`); a module's own invariant codes are its own.
 *
 * Every problem found by one check is collected first and thrown together,
 * so a deployment is fixed in one pass, not one boot per mistake.
 */

import { ArcError } from "./errors.js";

/** One reason the app cannot boot. */
export interface BootProblem {
  /** Stable identifier — match on this, never on `message`. */
  readonly code: string;
  /** What is wrong, already naming the module / key / subsystem involved. */
  readonly message: string;
  /** One line: what to change. */
  readonly fix: string;
  /** The module this problem belongs to, when it belongs to one. */
  readonly module?: string;
}

/**
 * Thrown by `createApp` for a configuration that cannot boot. `problems` lists
 * every failure found; `code` is the single problem's code, or `boot-failed`
 * when there are several.
 */
export class ArcBootError extends ArcError {
  override name = "ArcBootError";
  readonly problems: readonly BootProblem[];

  constructor(message: string, problems: readonly BootProblem[]) {
    const list = Object.freeze([...problems]);
    super(message, {
      code: list.length === 1 ? (list[0] as BootProblem).code : "boot-failed",
      details: { problems: list },
    });
    this.problems = list;
  }
}

/** One problem, thrown with its message verbatim. */
export function bootError(problem: BootProblem): ArcBootError {
  return new ArcBootError(problem.message, [problem]);
}

/** `header (N problems):` followed by one `[code] module "x": message` + `fix:` pair per problem. */
export function formatBootProblems(header: string, problems: readonly BootProblem[]): string {
  const count = `${problems.length} problem${problems.length === 1 ? "" : "s"}`;
  const lines = problems.map(
    (p) =>
      `  - [${p.code}]${p.module !== undefined ? ` module "${p.module}":` : ""} ${p.message}\n` +
      `    fix: ${p.fix}`,
  );
  return `${header} (${count}):\n${lines.join("\n")}`;
}
