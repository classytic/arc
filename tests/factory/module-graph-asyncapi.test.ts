import { describe, expect, it } from "vitest";
import { buildModuleGraph, defineModule, toAsyncApi } from "../../src/factory/index.js";

/** Every `$ref` in the document must point at something that exists. */
function danglingRefs(doc: Record<string, unknown>): string[] {
  const refs: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "$ref" && typeof x === "string") refs.push(x);
        else walk(x);
      }
    }
  };
  walk(doc);
  return refs.filter((ref) => {
    let node: unknown = doc;
    for (const part of ref.replace(/^#\//, "").split("/"))
      node = (node as Record<string, unknown>)?.[part];
    return node === undefined;
  });
}

describe("toAsyncApi — the module graph as an AsyncAPI 3.0 document", () => {
  const graph = buildModuleGraph(
    [
      defineModule({ name: "order", publishes: ["order:placed", "order:shipped"] }),
      defineModule({ name: "accounting", kind: "bridge" }),
    ],
    new Map([["accounting", ["order:*"]]]),
    [],
  );
  const catalog = [
    {
      name: "order:placed",
      version: 2,
      description: "An order was placed.",
      schema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      },
    },
  ];
  const doc = toAsyncApi(graph, catalog, { title: "Commerce events", version: "1.0.0" });

  it("one channel per event, payload from the catalog, the version carried", () => {
    expect(doc.asyncapi).toBe("3.0.0");
    const channels = doc.channels as Record<string, { address: string }>;
    expect(
      Object.values(channels)
        .map((c) => c.address)
        .sort(),
    ).toEqual(["order:placed", "order:shipped"]);
    const messages = (doc.components as { messages: Record<string, Record<string, unknown>> })
      .messages;
    expect(messages["order_placed"]).toMatchObject({
      name: "order:placed",
      "x-version": 2,
      summary: "An order was placed.",
    });
    expect(messages["order_shipped"]).toMatchObject({ "x-uncatalogued": true });
  });

  it("the owner sends, every consumer receives — wildcards resolved to concrete events", () => {
    const ops = doc.operations as Record<string, { action: string; tags: { name: string }[] }>;
    expect(Object.keys(ops).sort()).toEqual([
      "accounting.receive.order_placed",
      "accounting.receive.order_shipped",
      "order.send.order_placed",
      "order.send.order_shipped",
    ]);
    expect(ops["order.send.order_placed"]).toMatchObject({
      action: "send",
      tags: [{ name: "order" }],
    });
  });

  it("every $ref resolves", () => {
    expect(danglingRefs(doc)).toEqual([]);
  });
});
