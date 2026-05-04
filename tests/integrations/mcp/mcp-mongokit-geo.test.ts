/**
 * MongoKit 3.5.5 — Geo operators in MCP tool list calls
 *
 * Verifies that an AI agent calling an Arc-generated `list_*` MCP tool can
 * pass geo operator filters (e.g. `location_withinRadius`) and have them
 * round-trip through:
 *
 *   MCP tool call args
 *     → Arc's resourceToTools handler
 *     → expandOperatorKeys (rewrites `field_op` → `field[op]`)
 *     → buildRequestContext (puts the rewritten query on `req.query`)
 *     → BaseController.list → QueryResolver → MongoKit QueryParser geo branch
 *     → MongoDB
 *
 * The critical seam is `expandOperatorKeys` in buildRequestContext.ts — it
 * needs to recognize the geo operators MongoKit added in 3.5.5 (`near`,
 * `nearSphere`, `withinRadius`, `geoWithin`) so the bracket-notation
 * rewrite works. If MongoKit ever adds new operators that Arc doesn't know
 * about, the parser still gets the raw key (it just doesn't get the nested
 * shape MongoKit expects). This test pins the contract for the operators
 * we DO support today.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../../src/core/BaseController.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type { ToolContext } from "../../../src/integrations/mcp/types.js";
import { allowPublic } from "../../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../setup.js";

interface Place {
  name: string;
  location: { type: "Point"; coordinates: [number, number] };
}

const session: ToolContext = {
  session: null,
  log: vi.fn().mockResolvedValue(undefined),
  extra: {},
};

describe("MCP geo operator passthrough — Arc → MongoKit", () => {
  let Place: mongoose.Model<Place>;
  let listTool: ReturnType<typeof resourceToTools>[number];

  beforeAll(async () => {
    await setupTestDatabase();

    const PlaceSchema = new mongoose.Schema<Place>(
      {
        name: { type: String, required: true },
        location: {
          type: { type: String, enum: ["Point"], required: true },
          coordinates: { type: [Number], required: true },
        },
      },
      { timestamps: true },
    );
    PlaceSchema.index({ location: "2dsphere" });

    Place =
      (mongoose.models.McpGeoPlace as mongoose.Model<Place>) ||
      mongoose.model<Place>("McpGeoPlace", PlaceSchema);

    await Place.deleteMany({});
    await Place.syncIndexes();

    await Place.create([
      // Within 2 km of [-122.4194, 37.7749] (SF center)
      { name: "Near 1", location: { type: "Point", coordinates: [-122.4234, 37.7805] } },
      { name: "Near 2", location: { type: "Point", coordinates: [-122.4115, 37.777] } },
      // Far away (NYC)
      { name: "Far 1", location: { type: "Point", coordinates: [-73.9857, 40.7484] } },
    ]);

    const placeRepo = new Repository(Place);
    const placeResource = defineResource({
      name: "place",
      adapter: createMongooseAdapter({ model: Place, repository: placeRepo }),
      controller: new BaseController(placeRepo, {
        resourceName: "place",
        queryParser: new QueryParser({
          allowedFilterFields: ["location"],
          allowedOperators: ["eq", "near", "nearSphere", "withinRadius", "geoWithin"],
        }),
        tenantField: false,
      }),
      queryParser: new QueryParser({
        allowedFilterFields: ["location"],
        allowedOperators: ["eq", "near", "nearSphere", "withinRadius", "geoWithin"],
      }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const tools = resourceToTools(placeResource);
    const found = tools.find((t) => t.name === "list_places");
    if (!found) throw new Error("list_places tool not generated");
    listTool = found;
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  it("MCP `location_withinRadius` arg flows through to MongoKit and returns matches", async () => {
    // The MCP tool exposes flat field names with underscore-suffixed operators.
    // expandOperatorKeys() rewrites `location_withinRadius: "..."` into
    // { location: { withinRadius: "..." } }, which MongoKit's QueryParser
    // then translates into the canonical $geoWithin: $centerSphere shape.
    const result = await listTool.handler(
      { location_withinRadius: "-122.4194,37.7749,2000" },
      session,
    );

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? "";
    const body = JSON.parse(text) as { data: Place[]; total: number };
    expect(body.total).toBe(2);
    const names = body.data.map((d) => d.name).sort();
    expect(names).toEqual(["Near 1", "Near 2"]);
  });

  it("MCP `location_geoWithin` bounding box arg returns places inside the box", async () => {
    const result = await listTool.handler(
      { location_geoWithin: "-122.45,37.75,-122.40,37.79" },
      session,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]?.text ?? "{}") as { data: Place[] };
    const names = body.data.map((d) => d.name).sort();
    expect(names).toContain("Near 1");
    expect(names).toContain("Near 2");
    expect(names).not.toContain("Far 1");
  });
});
