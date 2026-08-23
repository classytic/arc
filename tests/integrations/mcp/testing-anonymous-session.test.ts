/**
 * `createTestMcpClient({ auth: null })` must actually run ANONYMOUSLY.
 *
 * The helper resolved its default with `const auth = options.auth ?? {...}`.
 * `??` coalesces `null` as well as `undefined`, so the one value a host writes
 * specifically to test rejection — `auth: null`, which the type documents as
 * legal — was silently replaced by an authenticated `test-user` session.
 *
 * The failure mode is the dangerous direction: a host's "anonymous callers are
 * refused" test called the tool as a logged-in user, got the refusal it
 * expected for the WRONG reason or no refusal at all, and shipped green. This
 * is a shipped helper (`@classytic/arc/mcp/testing`), so the false assurance
 * was public API.
 */

import { describe, expect, it } from "vitest";
import { defineResource } from "../../../src/core/defineResource.js";
import { createTestMcpClient } from "../../../src/integrations/mcp/testing.js";
import { allowPublic, requireAuth } from "../../../src/permissions/index.js";
import { anAdapter } from "../../_harness/index.js";

const resource = () =>
  defineResource({
    name: "task",
    prefix: "/tasks",
    adapter: anAdapter([{ _id: "t1", name: "one" }]),
    permissions: { list: requireAuth(), get: allowPublic() },
  });

describe("createTestMcpClient — session defaulting", () => {
  it("`auth: null` is refused by a requireAuth() tool", async () => {
    const client = await createTestMcpClient({
      pluginOptions: { resources: [resource()] },
      auth: null,
    });
    const result = await client.callTool("list_tasks", {});
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("401");
  });

  it("an OMITTED auth still gets the documented `test-user` default", async () => {
    // The other half of the fix: only `undefined` may take the default, so
    // the ergonomic no-arg case every existing test relies on is unchanged.
    const client = await createTestMcpClient({ pluginOptions: { resources: [resource()] } });
    const result = await client.callTool("list_tasks", {});
    await client.close();

    expect(result.isError).toBeFalsy();
  });

  it("an EXPLICIT session is honoured", async () => {
    const client = await createTestMcpClient({
      pluginOptions: { resources: [resource()] },
      auth: { userId: "alice", roles: ["member"] },
    });
    const result = await client.callTool("list_tasks", {});
    await client.close();

    expect(result.isError).toBeFalsy();
  });
});
