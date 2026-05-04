/**
 * Integration smoke for the Better Auth × Mongoose stub-model bridge.
 *
 * The helper itself lives in `@classytic/mongokit/better-auth` (kit owns the
 * kit-specific bridge). This file exercises the same surface from arc's
 * test environment so consumers of arc see a passing reference for
 * `populate()` against BA-owned collections.
 *
 * Validates that:
 *   1. Stub models register for the correct collection sets per plugin choice
 *   2. Registration is idempotent (safe to call repeatedly)
 *   3. usePlural and modelOverrides work
 *   4. extraCollections work for custom plugins
 *   5. Real `populate()` against a BA-style document succeeds end-to-end
 *      (the actual point of the helper)
 */

import { registerBetterAuthStubs } from "@classytic/mongokit/better-auth";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// ============================================================================
// Infrastructure
// ============================================================================

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  // Clean collections + deregister test models so each test starts fresh
  for (const key in mongoose.connection.collections) {
    await mongoose.connection.collections[key].deleteMany({});
  }
  for (const name of Object.keys(mongoose.models)) {
    mongoose.deleteModel(name);
  }
});

// ============================================================================
// Unit-level: registration behavior
// ============================================================================

describe("registerBetterAuthStubs (mongokit/better-auth) — registration behavior", () => {
  it("registers ONLY core models by default — does not silently include plugin sets", () => {
    // Default must be opt-in for plugins. Users who haven't enabled the
    // organization plugin should not get organization stubs registered.
    const registered = registerBetterAuthStubs(mongoose);
    expect(registered).toEqual(
      expect.arrayContaining(["user", "session", "account", "verification"]),
    );
    expect(registered).not.toContain("organization");
    expect(registered).not.toContain("member");
    expect(registered).not.toContain("invitation");
    expect(registered).not.toContain("team");
    expect(registered).not.toContain("twoFactor");
    expect(registered).not.toContain("jwks");
  });

  it("registers organization collections only when explicitly opted in", () => {
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: ["organization"],
    });
    expect(registered).toEqual(expect.arrayContaining(["organization", "member", "invitation"]));
    // No teams unless `organization-teams` is also passed
    expect(registered).not.toContain("team");
    expect(registered).not.toContain("teamMember");
  });

  it("registers team models when organization-teams plugin is included", () => {
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: ["organization", "organization-teams"],
    });
    expect(registered).toContain("team");
    expect(registered).toContain("teamMember");
  });

  it("can register only the core set when no plugins requested", () => {
    const registered = registerBetterAuthStubs(mongoose, { plugins: [] });
    expect(registered).toEqual(
      expect.arrayContaining(["user", "session", "account", "verification"]),
    );
    expect(registered).not.toContain("organization");
  });

  it("is idempotent — second call registers nothing new", () => {
    const first = registerBetterAuthStubs(mongoose);
    expect(first.length).toBeGreaterThan(0);

    const second = registerBetterAuthStubs(mongoose);
    expect(second).toEqual([]);
  });

  it("honors usePlural by appending 's' to model + collection names", () => {
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: ["organization"],
      usePlural: true,
    });
    expect(registered).toContain("users");
    expect(registered).toContain("sessions");
    expect(registered).toContain("organizations");
    expect(registered).toContain("members");
    expect(registered).not.toContain("user");

    // Verify the underlying collection name matches (this is what BA writes to)
    const userModel = mongoose.models.users as { collection: { collectionName: string } };
    expect(userModel.collection.collectionName).toBe("users");
  });

  it("respects modelOverrides for custom BA modelName mappings", () => {
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: ["organization"],
      modelOverrides: { user: "profile", member: "orgMember" },
    });
    expect(registered).toContain("profile");
    expect(registered).toContain("orgMember");
    expect(registered).not.toContain("user");
    expect(registered).not.toContain("member");

    const profileModel = mongoose.models.profile as { collection: { collectionName: string } };
    expect(profileModel.collection.collectionName).toBe("profile");
  });

  it("registers extraCollections for custom Better Auth plugins", () => {
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: [],
      extraCollections: ["customPlugin", "anotherCollection"],
    });
    expect(registered).toContain("customPlugin");
    expect(registered).toContain("anotherCollection");
  });

  it("registers jwt plugin collection (jwks)", () => {
    const registered = registerBetterAuthStubs(mongoose, { plugins: ["jwt"] });
    expect(registered).toContain("jwks");
  });

  it("registers twoFactor plugin collection", () => {
    const registered = registerBetterAuthStubs(mongoose, { plugins: ["twoFactor"] });
    expect(registered).toContain("twoFactor");
  });

  it("registers oidcProvider OAuth collections", () => {
    const registered = registerBetterAuthStubs(mongoose, { plugins: ["oidcProvider"] });
    expect(registered).toEqual(
      expect.arrayContaining(["oauthApplication", "oauthAccessToken", "oauthConsent"]),
    );
  });

  it("oauthProvider key is an alias for oidcProvider (same schema)", () => {
    const registered = registerBetterAuthStubs(mongoose, { plugins: ["oauthProvider"] });
    expect(registered).toEqual(
      expect.arrayContaining(["oauthApplication", "oauthAccessToken", "oauthConsent"]),
    );
  });

  it("mcp plugin reuses oidcProvider schema (data explicit)", () => {
    // Per Better Auth data: "The MCP plugin uses the same schema as the OIDC
    // Provider plugin." Selecting mcp must register the oauth* collections.
    const registered = registerBetterAuthStubs(mongoose, { plugins: ["mcp"] });
    expect(registered).toEqual(
      expect.arrayContaining(["oauthApplication", "oauthAccessToken", "oauthConsent"]),
    );
  });

  it("deduplicates collections when mcp + oidcProvider are selected together", () => {
    // Both share the exact same oauth* collection set — the helper must not
    // attempt to double-register (Mongoose would throw OverwriteModelError).
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: ["mcp", "oidcProvider"],
    });
    // Each oauth collection should appear exactly once in the returned list
    const count = (name: string) => registered.filter((n) => n === name).length;
    expect(count("oauthApplication")).toBe(1);
    expect(count("oauthAccessToken")).toBe(1);
    expect(count("oauthConsent")).toBe(1);
  });

  it("registers deviceAuthorization plugin collection (deviceCode)", () => {
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: ["deviceAuthorization"],
    });
    expect(registered).toContain("deviceCode");
  });

  it("handles separate @better-auth/* package plugins via extraCollections", () => {
    // @better-auth/passkey → 'passkey' (confirmed from BA data)
    // @better-auth/sso → 'ssoProvider' (confirmed from BA data)
    // These are NOT in the core BetterAuthPluginKey union on purpose —
    // they're separate packages that evolve independently.
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: ["organization"],
      extraCollections: ["passkey", "ssoProvider"],
    });
    expect(registered).toContain("passkey");
    expect(registered).toContain("ssoProvider");
    // Core + organization still present
    expect(registered).toContain("user");
    expect(registered).toContain("organization");
  });

  it("registers stub schemas with strict: false so they accept any BA document shape", async () => {
    registerBetterAuthStubs(mongoose);
    const UserModel = mongoose.models.user as mongoose.Model<Record<string, unknown>>;

    // Insert a doc shaped like a real BA user — fields not in the schema
    // should still round-trip because strict is off.
    const doc = await UserModel.create({
      _id: "usr_abc123",
      name: "Alice",
      email: "alice@example.com",
      emailVerified: true,
      role: "admin,recruiter",
      createdAt: new Date(),
    });
    expect(doc.toObject()).toMatchObject({
      _id: "usr_abc123",
      name: "Alice",
      email: "alice@example.com",
      role: "admin,recruiter",
    });
  });
});

// ============================================================================
// Integration: the actual point of the helper — `.populate()` works
// ============================================================================

describe("registerBetterAuthStubs — populate() integration", () => {
  it("lets an arc resource populate a ref to a BA-owned user document", async () => {
    // 1. Register stub models (this is the helper under test)
    registerBetterAuthStubs(mongoose);

    // 2. Simulate Better Auth writing a user via its native mongo driver.
    //    BA would do this via @better-auth/mongo-adapter — we shortcut by
    //    inserting directly into the same collection ('user') the stub points at.
    const userCollection = mongoose.connection.db?.collection("user");
    await userCollection.insertOne({
      _id: "usr_alice" as unknown as never,
      name: "Alice",
      email: "alice@example.com",
      emailVerified: true,
      createdAt: new Date(),
    });

    // 3. Define an arc-resource-style Mongoose schema with a ref to 'user'.
    const PostSchema = new mongoose.Schema({
      _id: { type: String },
      title: String,
      authorId: { type: String, ref: "user" },
    });
    const Post = mongoose.model("Post", PostSchema);

    await Post.create({
      _id: "post_1",
      title: "Hello world",
      authorId: "usr_alice",
    });

    // 4. The whole point: populate() should resolve against the BA collection.
    //    Without registerBetterAuthStubs, this throws MissingSchemaError.
    const populated = await Post.findById("post_1").populate("authorId").lean();

    expect(populated).toBeTruthy();
    expect(populated?.authorId).toMatchObject({
      _id: "usr_alice",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("populate works with usePlural collections too", async () => {
    registerBetterAuthStubs(mongoose, { usePlural: true });

    // Insert into the pluralized 'users' collection (matching usePlural: true)
    await mongoose.connection.db?.collection("users").insertOne({
      _id: "usr_bob" as unknown as never,
      name: "Bob",
      email: "bob@example.com",
    });

    const PostSchema = new mongoose.Schema({
      _id: { type: String },
      title: String,
      authorId: { type: String, ref: "users" },
    });
    const Post = mongoose.model("Post", PostSchema);

    await Post.create({ _id: "post_2", title: "Plural test", authorId: "usr_bob" });

    const populated = await Post.findById("post_2").populate("authorId").lean();
    expect(populated?.authorId).toMatchObject({ _id: "usr_bob", name: "Bob" });
  });
});
