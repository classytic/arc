/**
 * Arc Full Example App
 *
 * Demonstrates createApp with JWT auth, multiple resources,
 * presets, permissions, hooks, and events.
 */

import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { createApp } from "../../src/factory/index.js";
import { userResource } from "./resources/user.resource.js";
import { postResource } from "./resources/post.resource.js";

export interface AppOptions {
  mongoUri: string;
  jwtSecret: string;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  await mongoose.connect(opts.mongoUri);

  const app = await createApp({
    auth: {
      type: "jwt",
      jwt: { secret: opts.jwtSecret },
    },
    resources: [userResource, postResource],
  });

  return app;
}
