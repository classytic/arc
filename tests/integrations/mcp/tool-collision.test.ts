/**
 * MCP tool-name collision resolution.
 *
 * Pins the two-axis contract:
 *   - Preset vs user collision → auto-namespace the preset side
 *     (softDelete's `restore_<resource>` becomes `softdelete_restore_<resource>`
 *     when a user `actions.restore` is also declared).
 *   - Any other collision → typed ArcError naming BOTH sources so the
 *     host's stack trace points at the resource definitions, not the
 *     MCP SDK internals.
 */

import { describe, expect, it } from "vitest";
import { resolveToolCollisions } from "../../../src/integrations/mcp/createMcpServer.js";
import type { ToolDefinition } from "../../../src/integrations/mcp/types.js";
import { ArcError } from "../../../src/utils/errors.js";

function tool(name: string, source: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    source,
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

describe("resolveToolCollisions", () => {
  it("passes unique tools through unchanged", () => {
    const out = resolveToolCollisions([
      tool("list_post", "crud:post:list"),
      tool("get_post", "crud:post:get"),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.name)).toEqual(["list_post", "get_post"]);
  });

  it("auto-namespaces a preset tool when a user tool shadows it", () => {
    const out = resolveToolCollisions([
      tool("restore_post", "preset:softDelete:post:restore"),
      tool("restore_post", "action:post:restore"),
    ]);
    expect(out).toHaveLength(2);
    const names = out.map((t) => t.name).sort();
    expect(names).toEqual(["restore_post", "softdelete_restore_post"]);
  });

  it("keeps the user tool's original name when auto-namespacing", () => {
    const out = resolveToolCollisions([
      tool("restore_post", "preset:softDelete:post:restore"),
      tool("restore_post", "action:post:restore"),
    ]);
    const user = out.find((t) => t.source === "action:post:restore");
    expect(user?.name).toBe("restore_post");
  });

  it("throws ArcError naming both sources on user-vs-user collisions", () => {
    expect(() =>
      resolveToolCollisions([
        tool("approve_order", "action:order:approve"),
        tool("approve_order", "route:order:POST /approve"),
      ]),
    ).toThrow(ArcError);

    try {
      resolveToolCollisions([
        tool("approve_order", "action:order:approve"),
        tool("approve_order", "route:order:POST /approve"),
      ]);
    } catch (err) {
      expect(err).toBeInstanceOf(ArcError);
      const arcErr = err as ArcError;
      expect(arcErr.code).toBe("arc.mcp.tool_name_collision");
      expect(arcErr.message).toContain("action:order:approve");
      expect(arcErr.message).toContain("route:order:POST /approve");
      expect(arcErr.message).toContain("approve_order");
    }
  });

  it("throws on three-way collisions even when one is a preset", () => {
    expect(() =>
      resolveToolCollisions([
        tool("restore_post", "preset:softDelete:post:restore"),
        tool("restore_post", "action:post:restore"),
        tool("restore_post", "route:post:POST /restore"),
      ]),
    ).toThrow(/3 sources/);
  });

  it("labels missing sources as (unknown) in the error message", () => {
    expect(() =>
      resolveToolCollisions([
        { ...tool("foo", "action:x:foo"), source: undefined },
        tool("foo", "action:x:foo"),
      ]),
    ).toThrow(/\(unknown\)/);
  });
});
