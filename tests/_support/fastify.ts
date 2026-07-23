/**
 * Fastify lifecycle helper — create instances that are ALWAYS closed, even
 * when a test throws before its own cleanup. Call `useFastify()` at
 * describe scope; every `create()`d app is closed in `afterEach`.
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { afterEach } from "vitest";

export function useFastify(defaults: FastifyServerOptions = {}) {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  });

  return {
    create(options: FastifyServerOptions = {}): FastifyInstance {
      const app = Fastify({ logger: false, ...defaults, ...options });
      apps.push(app);
      return app;
    },
    /** Track an app created elsewhere (e.g. by createApp) for auto-close. */
    track<T extends FastifyInstance>(app: T): T {
      apps.push(app);
      return app;
    },
  };
}
