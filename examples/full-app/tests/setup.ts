/**
 * Shared test setup for the full-app example.
 *
 * Boots MongoDB in-memory, creates a Fastify app with JWT auth,
 * and provides helper functions for authenticated requests.
 */

import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createApp, loadResources } from "../../../src/factory/index.js";
import { UserModel } from "../resources/user.resource.js";

const JWT_SECRET = "arc-example-test-secret-must-be-at-least-32-chars-long";

let mongo: MongoMemoryServer;
let app: FastifyInstance;

export async function setupApp(): Promise<FastifyInstance> {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  app = await createApp({
    auth: {
      type: "jwt",
      jwt: { secret: JWT_SECRET },
    },
    // Auto-discover all *.resource.ts files in the resources directory.
    // Resolves relative to THIS file — works in src/ (dev) and dist/ (prod).
    resources: await loadResources(new URL("../resources", import.meta.url).href),
  });

  await app.ready();
  return app;
}

export async function teardownApp(): Promise<void> {
  await app?.close();
  await mongoose.disconnect();
  await mongo?.stop();
}

/** Create a JWT token for testing */
export function createToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });
}

/** Seed a test user in the database and return a token */
export async function seedUser(
  data: { name: string; email: string; role?: string },
): Promise<{ user: Record<string, unknown>; token: string }> {
  const user = await UserModel.create({
    name: data.name,
    email: data.email,
    role: data.role ?? "viewer",
  });
  const plain = user.toObject();
  const token = createToken({
    id: plain._id.toString(),
    email: plain.email,
    role: plain.role,
    roles: [plain.role],
  });
  return { user: plain as Record<string, unknown>, token };
}
