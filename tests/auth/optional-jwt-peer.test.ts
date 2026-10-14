import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runWithoutJwt(body: string) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@fastify/jwt') {
        throw Object.assign(new Error("Cannot find package '@fastify/jwt'"), {
          code: 'ERR_MODULE_NOT_FOUND',
        });
      }
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
          return nextResolve(specifier.slice(0, -3) + '.ts', context);
        }
        throw error;
      }
    }});
    ${body}
  `,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
  );
}

describe("optional JWT peer", () => {
  it("imports auth and boots Better Auth without resolving JWT", () => {
    const result = runWithoutJwt(`
      const { createBetterAuthAdapter } = await import('./src/auth/index.ts');
      const { createApp } = await import('./src/factory/createApp.ts');
      const adapter = createBetterAuthAdapter({
        auth: {
          handler: async () => new Response('{}'),
          api: { getSession: async () => ({
            user: { id: 'user-1' }, session: { id: 'session-1' },
          }) },
        },
      });
      const app = await createApp({
        preset: 'testing', logger: false,
        auth: { type: 'betterAuth', betterAuth: adapter },
        plugins: async (app) => {
          app.get('/protected', { preHandler: app.authenticate },
            async (request) => ({ id: request.user.id }));
        },
      });
      try {
        const response = await app.inject({
          url: '/protected', headers: { authorization: 'Bearer test-session' },
        });
        if (response.statusCode !== 200 || response.json().id !== 'user-1') {
          throw new Error(response.body);
        }
      } finally { await app.close(); }
    `);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it("explains the missing dependency when JWT is explicitly configured", () => {
    const result = runWithoutJwt(`
      const { createApp } = await import('./src/factory/createApp.ts');
      await createApp({ preset: 'testing', logger: false,
        auth: { type: 'jwt', jwt: { secret: 'test-secret-32-chars-minimum-len' } },
      });
    `);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm install @fastify/jwt");
  });
});
