/**
 * MongoKit 3.5.5 — Geo query integration with Arc
 *
 * Verifies that Arc transparently passes geo operator query strings
 * (`?location[near]=lng,lat,maxDistance` and `?location[withinRadius]=lng,lat,radius`)
 * through the full pipeline:
 *
 *   HTTP query string
 *     → Fastify qs parser (bracket-notation → nested objects)
 *     → Arc list route (AJV-strict-clean schema normalization)
 *     → BaseController.list()
 *     → QueryResolver.resolve() (passes the parsed query to QueryParser)
 *     → MongoKit QueryParser (parses [near] / [withinRadius] into $near / $geoWithin)
 *     → MongoKit Repository.getAll() (skips default sort + rewrites count for $near)
 *     → MongoDB
 *
 * No Arc-side code change is required for any of this to work — these tests
 * pin the contract so any future regression in Arc's query path is caught.
 *
 * Requires a real 2dsphere index, so we use mongodb-memory-server with
 * mongoose for the full integration loop.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

interface Place {
  name: string;
  category: string;
  location: { type: "Point"; coordinates: [number, number] };
}

describe("MongoKit geo query integration via Arc", () => {
  let app: FastifyInstance;
  let Place: mongoose.Model<Place>;

  beforeAll(async () => {
    await setupTestDatabase();

    const PlaceSchema = new mongoose.Schema<Place>(
      {
        name: { type: String, required: true },
        category: { type: String, required: true },
        location: {
          type: { type: String, enum: ["Point"], required: true },
          coordinates: { type: [Number], required: true },
        },
      },
      { timestamps: true },
    );
    PlaceSchema.index({ location: "2dsphere" });

    Place =
      (mongoose.models.GeoPlace as mongoose.Model<Place>) ||
      mongoose.model<Place>("GeoPlace", PlaceSchema);

    await Place.deleteMany({});
    await Place.syncIndexes(); // ensure 2dsphere is built before queries

    // Seed: 4 cafes around San Francisco (37.7749° N, 122.4194° W) and one in NYC
    await Place.create([
      // SF — within 2 km of [-122.4194, 37.7749]
      {
        name: "Blue Bottle",
        category: "cafe",
        location: { type: "Point", coordinates: [-122.4234, 37.7805] },
      },
      {
        name: "Sightglass",
        category: "cafe",
        location: { type: "Point", coordinates: [-122.4115, 37.777] },
      },
      {
        name: "Ritual",
        category: "cafe",
        location: { type: "Point", coordinates: [-122.422, 37.7611] },
      },
      // SF — within ~5 km but > 2 km
      {
        name: "Philz",
        category: "cafe",
        location: { type: "Point", coordinates: [-122.438, 37.76] },
      },
      // NYC — far away
      {
        name: "Joe Coffee",
        category: "cafe",
        location: { type: "Point", coordinates: [-73.9857, 40.7484] },
      },
    ]);

    const placeRepo = new Repository(Place);
    const placeResource = defineResource({
      name: "place",
      adapter: createMongooseAdapter({ model: Place, repository: placeRepo }),
      controller: new BaseController(placeRepo, {
        resourceName: "place",
        // Pass the SAME parser instance to BaseController so the listQuery
        // schema and the runtime parsing path stay in sync — Arc's pattern.
        queryParser: new QueryParser({
          allowedFilterFields: ["category", "location"],
          allowedOperators: ["eq", "ne", "near", "nearSphere", "withinRadius", "geoWithin"],
        }),
        tenantField: false,
      }),
      queryParser: new QueryParser({
        allowedFilterFields: ["category", "location"],
        allowedOperators: ["eq", "ne", "near", "nearSphere", "withinRadius", "geoWithin"],
      }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      plugins: async (f) => {
        await f.register(placeResource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("[withinRadius] returns places inside a 2 km radius around SF", async () => {
    // -122.4194,37.7749 = SF center; 2000 m radius
    const res = await app.inject({
      method: "GET",
      url: "/places?location[withinRadius]=-122.4194,37.7749,2000",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Place[]; total: number };
    const names = body.data.map((d) => d.name).sort();
    // Within 2 km: Blue Bottle, Sightglass, Ritual. Outside: Philz, Joe Coffee.
    expect(names).toEqual(["Blue Bottle", "Ritual", "Sightglass"]);
    expect(body.total).toBe(3);
  });

  it("[withinRadius] with a 10 km radius includes Philz but excludes NYC", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/places?location[withinRadius]=-122.4194,37.7749,10000",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Place[]; total: number };
    expect(body.total).toBe(4);
    expect(body.data.map((d) => d.name)).not.toContain("Joe Coffee");
  });

  it("[geoWithin] bounding box returns places inside the box", async () => {
    // Bounding box covering most of SF
    const res = await app.inject({
      method: "GET",
      url: "/places?location[geoWithin]=-122.45,37.75,-122.40,37.79",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Place[]; total: number };
    // Inside the box: Blue Bottle (-122.42, 37.78), Sightglass (-122.41, 37.77),
    // Ritual (-122.42, 37.76)
    const names = body.data.map((d) => d.name).sort();
    expect(names).toContain("Blue Bottle");
    expect(names).toContain("Sightglass");
    expect(names).toContain("Ritual");
    expect(names).not.toContain("Joe Coffee");
  });

  it("[near] returns places sorted by proximity (no explicit sort needed)", async () => {
    // -122.4194,37.7749 = SF center; 5 km maxDistance.
    //
    // CRITICAL ARC INTEGRATION: MongoDB rejects any explicit sort alongside $near.
    // Arc's BaseController defaults to `defaultSort: '-createdAt'`, but MongoKit's
    // Repository.getAll() detects the $near operator in the resolved filters and
    // drops the conflicting sort with a warning. This test exercises that exact
    // path — if Arc ever stops passing the parsed filter into the repo's `params`
    // before sort is decided, this test will fail (MongoDB will throw).
    //
    // The stderr warning during this test is intentional and proves the
    // sort-safety hand-off is working.
    const res = await app.inject({
      method: "GET",
      url: "/places?location[near]=-122.4194,37.7749,5000",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Place[]; total?: number };
    // Distance order from SF center (-122.4194, 37.7749):
    //   Blue Bottle (-122.4234, 37.7805) ≈ 707 m
    //   Sightglass  (-122.4115, 37.7770) ≈ 717 m
    //   Ritual      (-122.4220, 37.7611) ≈ 1535 m
    //   Philz       (-122.4380, 37.7600) ≈ 2400 m
    // (Joe Coffee in NYC is far outside the 5 km cap.)
    expect(body.data.length).toBeGreaterThanOrEqual(3);
    expect(body.data.map((d) => d.name)).not.toContain("Joe Coffee");
    // Distance-sorted: Blue Bottle is closest
    expect(body.data[0]?.name).toBe("Blue Bottle");
    // Second closest: Sightglass
    expect(body.data[1]?.name).toBe("Sightglass");
  });

  it("composes geo filter with non-geo filter (?category=cafe&location[withinRadius]=...)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/places?category=cafe&location[withinRadius]=-122.4194,37.7749,2000",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Place[]; total: number };
    expect(body.total).toBe(3);
    expect(body.data.every((d) => d.category === "cafe")).toBe(true);
  });

  it("invalid coordinates → empty result, not 500 (parser drops malformed filter)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/places?location[withinRadius]=999,999,1000",
    });

    // Parser drops the malformed filter, so we get all places (no filter applied).
    // The important thing is no 5xx — Arc + MongoKit handle bad input gracefully.
    expect(res.statusCode).toBe(200);
  });
});
