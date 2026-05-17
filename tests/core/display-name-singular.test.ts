/**
 * Tests for the 2.15.5 singular-displayName default (OpenAI-team report).
 *
 * Before 2.15.5 `defineResource({ name: 'shot' })` defaulted
 * `displayName` to `Shots` (capitalized + 's'). Every singular context
 * then rendered as "Get a single shots by ID", and the list description
 * called `pluralize('shots')` and got "shotses". The fix changes the
 * default to the SINGULAR form (`capitalize(name)`) and pluralizes
 * on demand where grammar requires plural — the OpenAPI list summary,
 * the CRUD list MCP description, the tag default.
 *
 * Contract this file locks in:
 *  - `displayName` defaults to `capitalize(name)` (singular).
 *  - `tag` defaults to `pluralize(displayName)` so the OpenAPI section
 *    header stays the natural plural grouping.
 *  - CRUD MCP descriptions read correctly for all op kinds.
 *  - OpenAPI summaries pluralize for `list` and stay singular for
 *    `get` / `create` / `update` / `delete`.
 */

import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { defaultCrudDescription } from "../../src/integrations/mcp/crud-tools.js";
import { allowPublic } from "../../src/permissions/index.js";

describe("displayName — singular default (2.15.5)", () => {
  it("defaults `displayName` to the singular form of the resource name", () => {
    const r = defineResource({
      name: "shot",
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
    });
    expect(r.displayName).toBe("Shot");
  });

  it("preserves compound names (kebab-case) without re-singularizing", () => {
    // `voice-clip` should stay `Voice-clip` (singular, capitalised first
    // letter). The pre-2.15.5 bug produced `Voice-clips` (plural) here.
    const r = defineResource({
      name: "voice-clip",
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
    });
    expect(r.displayName).toBe("Voice-clip");
  });

  it("derives a plural `tag` from the singular `displayName`", () => {
    // Default tag (used as OpenAPI section header / MCP tool grouping) is
    // the natural plural reading of displayName. Pre-2.15.5 the tag and
    // displayName collapsed to the same plural string, leaving no way to
    // get a singular displayName without setting both fields manually.
    const r = defineResource({
      name: "voice-clip",
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
    });
    expect(r.tag).toBe("Voice-clips");
  });

  it("honors an explicit `displayName` — host wins over the default", () => {
    const r = defineResource({
      name: "post",
      displayName: "Blog Post",
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
    });
    expect(r.displayName).toBe("Blog Post");
    expect(r.tag).toBe("Blog Posts");
  });
});

describe("defaultCrudDescription — readable singular + plural mix", () => {
  it("singular contexts: get / create / update / delete", () => {
    // Reading the displayName the new singular default produces — the
    // descriptions read naturally for every CRUD op. Pre-2.15.5 these
    // said "Get a single shots by ID".
    expect(defaultCrudDescription("get", "Shot", false)).toBe("Get a single shot by ID");
    expect(defaultCrudDescription("create", "Voice-clip", false)).toBe("Create a new voice-clip");
    expect(defaultCrudDescription("update", "Image-post", false)).toBe(
      "Update an existing image-post by ID",
    );
    expect(defaultCrudDescription("delete", "Shot", false)).toBe("Delete a shot by ID");
  });

  it("list pluralizes the noun (was double-pluralized pre-2.15.5)", () => {
    expect(defaultCrudDescription("list", "Shot", false)).toContain("List shots");
    expect(defaultCrudDescription("list", "Voice-clip", false)).toContain("List voice-clips");
    expect(defaultCrudDescription("list", "Image-post", false)).toContain("List image-posts");
    // Sanity: the pre-2.15.5 output "List shotses" / "List voice-clipses"
    // does NOT appear anywhere in the rendered text.
    expect(defaultCrudDescription("list", "Shot", false)).not.toContain("shotses");
    expect(defaultCrudDescription("list", "Voice-clip", false)).not.toContain("voice-clipses");
  });

  it("delete with soft-delete reads correctly (singular)", () => {
    const desc = defaultCrudDescription("delete", "Voice-clip", true);
    expect(desc).toBe(
      "Delete a voice-clip by ID (soft delete — marks as deleted, not permanently removed)",
    );
  });
});
