/**
 * The agent-facing skills and llms.txt stay small, current and true.
 * The rules live in scripts/check-skills.mjs (size budgets, shape, banned wording,
 * every `@classytic/arc` subpath and imported name exists in the built API surface).
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no declarations
import { checkSkills } from "../../scripts/check-skills.mjs";

describe("skills", () => {
  it("pass scripts/check-skills.mjs", () => {
    const failures: string[] = checkSkills();
    expect(failures).toEqual([]);
  });
});
