import { describe, expect, it, vi } from "vitest";
import { MemoryIdempotencyStore } from "../../../src/idempotency/stores/memory.js";
import { runIdempotentTool } from "../../../src/integrations/mcp/http-parity.js";

describe("MCP idempotency security context", () => {
  it("isolates the same user and key across organizations", async () => {
    const store = new MemoryIdempotencyStore();
    const dispatch = vi.fn(async () => ({
      content: [{ type: "text", text: String(dispatch.mock.calls.length) }],
    }));
    const args = {
      store,
      key: "k",
      resourceName: "invoice",
      operation: "create",
      input: { amount: 10 },
      dispatch,
    };
    const first = await runIdempotentTool({
      ...args,
      session: { userId: "u", organizationId: "org-a" },
    });
    const second = await runIdempotentTool({
      ...args,
      session: { userId: "u", organizationId: "org-b" },
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(first).not.toEqual(second);
  });

});
