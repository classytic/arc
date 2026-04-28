/**
 * CORS Configuration Tests
 *
 * Comprehensive tests for CORS behavior in the Arc factory:
 * - Origin patterns: string, array, regex, boolean, function, wildcard
 * - Credentials + origin interaction (browser rejects `*` with credentials)
 * - Production safety gate (explicit origin required)
 * - Preflight (OPTIONS) handling
 * - Custom headers passthrough
 * - Disabled CORS (cors: false)
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

// Helper: create a minimal app with given CORS config
async function buildApp(corsConfig: unknown, preset?: string): Promise<FastifyInstance> {
  return createApp({
    preset: preset as any,
    auth: false,
    logger: false,
    helmet: false,
    rateLimit: false,
    underPressure: false,
    cors: corsConfig as any,
  });
}

// Helper: send an OPTIONS preflight request
async function preflight(app: FastifyInstance, origin: string, method = "POST") {
  return app.inject({
    method: "OPTIONS",
    url: "/",
    headers: {
      origin,
      "access-control-request-method": method,
    },
  });
}

// Helper: send a normal GET with Origin header
async function getWithOrigin(app: FastifyInstance, origin: string) {
  return app.inject({
    method: "GET",
    url: "/health",
    headers: { origin },
  });
}

describe("CORS origin patterns", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  // ============================================================================
  // origin: true — reflect any origin
  // ============================================================================

  it("origin: true should reflect the request Origin header", async () => {
    app = await buildApp({ origin: true });

    const res = await getWithOrigin(app, "https://example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
  });

  it("origin: true should reflect different origins", async () => {
    app = await buildApp({ origin: true });

    const res1 = await getWithOrigin(app, "https://app.example.com");
    expect(res1.headers["access-control-allow-origin"]).toBe("https://app.example.com");

    const res2 = await getWithOrigin(app, "http://localhost:3000");
    expect(res2.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  // ============================================================================
  // origin: '*' — wildcard (literal)
  // ============================================================================

  it('origin: "*" should return Access-Control-Allow-Origin: *', async () => {
    app = await buildApp({ origin: "*" });

    const res = await getWithOrigin(app, "https://anywhere.com");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  // ============================================================================
  // origin: specific string
  // ============================================================================

  it("origin: specific string should set that origin in header", async () => {
    app = await buildApp({ origin: "https://myapp.com" });

    const allowed = await getWithOrigin(app, "https://myapp.com");
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://myapp.com");

    // Note: @fastify/cors with a single string origin always returns that string
    // regardless of the request Origin. Use an array for strict matching.
    const other = await getWithOrigin(app, "https://other.com");
    expect(other.headers["access-control-allow-origin"]).toBe("https://myapp.com");
  });

  // ============================================================================
  // origin: array of strings
  // ============================================================================

  it("origin: array should allow listed origins", async () => {
    app = await buildApp({
      origin: ["https://app.example.com", "https://admin.example.com", "http://localhost:3000"],
    });

    const app1 = await getWithOrigin(app, "https://app.example.com");
    expect(app1.headers["access-control-allow-origin"]).toBe("https://app.example.com");

    const admin = await getWithOrigin(app, "https://admin.example.com");
    expect(admin.headers["access-control-allow-origin"]).toBe("https://admin.example.com");

    const local = await getWithOrigin(app, "http://localhost:3000");
    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

    const denied = await getWithOrigin(app, "https://hacker.com");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // ============================================================================
  // origin: regex pattern
  // ============================================================================

  it("origin: regex should match patterns", async () => {
    app = await buildApp({
      origin: /\.example\.com$/,
    });

    const sub1 = await getWithOrigin(app, "https://app.example.com");
    expect(sub1.headers["access-control-allow-origin"]).toBe("https://app.example.com");

    const sub2 = await getWithOrigin(app, "https://api.example.com");
    expect(sub2.headers["access-control-allow-origin"]).toBe("https://api.example.com");

    const denied = await getWithOrigin(app, "https://example.org");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // ============================================================================
  // origin: array with regex + strings (mixed)
  // ============================================================================

  it("origin: mixed array (strings + regex) should match all", async () => {
    app = await buildApp({
      origin: ["http://localhost:3000", /\.myapp\.com$/],
    });

    const local = await getWithOrigin(app, "http://localhost:3000");
    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

    const sub = await getWithOrigin(app, "https://dashboard.myapp.com");
    expect(sub.headers["access-control-allow-origin"]).toBe("https://dashboard.myapp.com");

    const denied = await getWithOrigin(app, "https://other.com");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // ============================================================================
  // origin: function (dynamic)
  // ============================================================================

  it("origin: function should allow dynamic per-request decisions", async () => {
    const allowedOrigins = new Set(["https://app1.com", "https://app2.com"]);

    app = await buildApp({
      origin: (origin: string, cb: (err: Error | null, allow: boolean) => void) => {
        cb(null, allowedOrigins.has(origin));
      },
    });

    const app1 = await getWithOrigin(app, "https://app1.com");
    expect(app1.headers["access-control-allow-origin"]).toBe("https://app1.com");

    const denied = await getWithOrigin(app, "https://evil.com");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // ============================================================================
  // origin: false — CORS headers not set
  // ============================================================================

  it("origin: false should not set CORS headers", async () => {
    app = await buildApp({ origin: false });

    const res = await getWithOrigin(app, "https://example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

// ============================================================================
// Credentials + Origin interaction
// ============================================================================

describe("CORS credentials handling", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("credentials: true with origin: true should reflect origin and set credentials header", async () => {
    app = await buildApp({ origin: true, credentials: true });

    const res = await getWithOrigin(app, "https://myapp.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://myapp.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it('credentials: true with origin: "*" should auto-convert to origin: true (smart CORS)', async () => {
    // Browsers reject Access-Control-Allow-Origin: * with credentials.
    // Arc's smart CORS converts origin: '*' to origin: true when credentials are enabled.
    app = await buildApp({ origin: "*", credentials: true });

    const res = await getWithOrigin(app, "https://myapp.com");
    // Should reflect origin, NOT literal '*'
    expect(res.headers["access-control-allow-origin"]).toBe("https://myapp.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it('credentials: false with origin: "*" should return literal *', async () => {
    app = await buildApp({ origin: "*", credentials: false });

    const res = await getWithOrigin(app, "https://myapp.com");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    // No credentials header
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("credentials: true with specific origin should work normally", async () => {
    app = await buildApp({ origin: "https://trusted.com", credentials: true });

    const res = await getWithOrigin(app, "https://trusted.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://trusted.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});

// ============================================================================
// Preflight (OPTIONS) handling
// ============================================================================

describe("CORS preflight requests", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("OPTIONS preflight should return 204 with CORS headers", async () => {
    app = await buildApp({
      origin: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    });

    const res = await preflight(app, "https://myapp.com", "POST");
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://myapp.com");
    expect(res.headers["access-control-allow-methods"]).toBeDefined();
  });

  it("OPTIONS preflight should include custom allowed headers", async () => {
    app = await buildApp({
      origin: true,
      allowedHeaders: ["Content-Type", "Authorization", "x-organization-id", "x-custom-header"],
    });

    const res = await preflight(app, "https://myapp.com");
    const allowedHeaders = res.headers["access-control-allow-headers"] as string;
    expect(allowedHeaders).toContain("x-organization-id");
    expect(allowedHeaders).toContain("x-custom-header");
  });

  it("OPTIONS preflight with array origin should reject non-listed origins", async () => {
    app = await buildApp({ origin: ["https://trusted.com"] });

    // Listed origin — should be allowed
    const allowed = await preflight(app, "https://trusted.com");
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://trusted.com");

    // Non-listed origin — @fastify/cors with array rejects by not reflecting
    const denied = await preflight(app, "https://evil.com");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

// ============================================================================
// Production safety gate
// ============================================================================

describe("CORS production safety", () => {
  it("production preset without explicit origin should warn but not throw", async () => {
    // Changed from hard error to warning — users may rely on proxy/CDN CORS
    const app = await createApp({
      preset: "production",
      auth: false,
      logger: false,
      helmet: false,
      rateLimit: false,
      underPressure: false,
      cors: { credentials: true }, // No origin specified — warn, don't throw
    });

    expect(app).toBeDefined();
    await app.close();
  });

  it('production preset with origin: "*" should work (from env vars)', async () => {
    const app = await createApp({
      preset: "production",
      auth: false,
      logger: false,
      helmet: false,
      rateLimit: false,
      underPressure: false,
      cors: { origin: "*" },
    });

    const res = await getWithOrigin(app, "https://anything.com");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    await app.close();
  });

  it("production preset with explicit origin should succeed", async () => {
    const app = await createApp({
      preset: "production",
      auth: false,
      logger: false,
      helmet: false,
      rateLimit: false,
      underPressure: false,
      cors: { origin: ["https://myapp.com"], credentials: true },
    });

    const res = await getWithOrigin(app, "https://myapp.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://myapp.com");

    await app.close();
  });

  it("production preset with origin: undefined should warn (env-derived origin missing — 2.11.3)", async () => {
    // Regression: pre-2.11.3, the production warning used
    //   `!('origin' in corsOptions)` which was `false` for `{ origin: undefined }`.
    // The canonical env-derived pattern
    //   `cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') }`
    // therefore skipped the warning when the env var was unset, leaving CORS
    // silently mis-wired. Post-fix: `corsOptions.origin === undefined` is
    // treated as missing, so the production warning fires.
    const warns: string[] = [];
    const app = await createApp({
      preset: "production",
      auth: false,
      // Custom logger that captures warns — the default logger flushes
      // warnings to stdout which Vitest doesn't surface in this test.
      logger: {
        level: "warn",
        // biome-ignore lint/suspicious/noExplicitAny: pino-style logger shim
        stream: {
          write(chunk: string) {
            try {
              const parsed = JSON.parse(chunk) as { level?: number; msg?: string };
              if (parsed.level === 40 && parsed.msg) warns.push(parsed.msg);
            } catch {
              warns.push(chunk);
            }
          },
        } as any,
      },
      helmet: false,
      rateLimit: false,
      underPressure: false,
      cors: { origin: undefined, credentials: true }, // env-derived undefined
    });

    expect(app).toBeDefined();
    const corsWarn = warns.find((w) => /CORS origin is not explicitly configured/.test(w));
    expect(corsWarn).toBeDefined();
    expect(corsWarn).toMatch(/fail fast on missing/);
    await app.close();
  });

  it("production preset with origin: false should succeed (CORS disabled)", async () => {
    const app = await createApp({
      preset: "production",
      auth: false,
      logger: false,
      helmet: false,
      rateLimit: false,
      underPressure: false,
      cors: { origin: false },
    });

    const res = await getWithOrigin(app, "https://myapp.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("production microservice pattern: { origin: '*', credentials: false } — explicit, no warning, reflects '*'", async () => {
    // Policy decision documented as a test so the contract can't drift:
    // for server-to-server / API-key services, allowing all origins with
    // credentials disabled IS a valid production CORS posture (CORS is a
    // browser-only concern; non-browser clients ignore it). The production
    // safety check should NOT warn here — the host has made an explicit,
    // intentional choice. Distinct from the env-derived `origin: undefined`
    // case (which DOES warn — see "origin: undefined should warn" above).
    const warns: string[] = [];
    const app = await createApp({
      preset: "production",
      auth: false,
      logger: {
        level: "warn",
        // biome-ignore lint/suspicious/noExplicitAny: pino-style logger shim
        stream: {
          write(chunk: string) {
            try {
              const parsed = JSON.parse(chunk) as { level?: number; msg?: string };
              if (parsed.level === 40 && parsed.msg) warns.push(parsed.msg);
            } catch {
              warns.push(chunk);
            }
          },
        } as any,
      },
      helmet: false,
      rateLimit: false,
      underPressure: false,
      cors: { origin: "*", credentials: false },
    });

    // No "CORS origin is not explicitly configured" warning — the host
    // declared their CORS posture intentionally.
    const corsWarn = warns.find((w) => /CORS origin is not explicitly configured/.test(w));
    expect(corsWarn).toBeUndefined();

    // Wildcard origin → reflects '*' for any caller. Browsers treat the
    // response as CORS-allowed but won't attach credentials (per the
    // explicit `credentials: false`), which is exactly what an API-key
    // microservice wants.
    const res = await getWithOrigin(app, "https://anything.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();

    await app.close();
  });
});

// ============================================================================
// cors: false — completely disabled
// ============================================================================

describe("CORS disabled", () => {
  it("cors: false should not register CORS at all", async () => {
    const app = await buildApp(false);

    const res = await getWithOrigin(app, "https://example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();

    // Preflight should get a 404 (no handler for OPTIONS)
    // or default response — no CORS headers either way
    const pre = await preflight(app, "https://example.com");
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });
});

// ============================================================================
// Development preset defaults
// ============================================================================

describe("CORS development preset", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("development preset should allow all origins by default", async () => {
    app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      rateLimit: false,
      underPressure: false,
    });

    const res = await getWithOrigin(app, "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("development preset should allow any frontend dev server origin", async () => {
    app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      rateLimit: false,
      underPressure: false,
    });

    // Vite default
    const vite = await getWithOrigin(app, "http://localhost:5173");
    expect(vite.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    // Next.js default
    const next = await getWithOrigin(app, "http://localhost:3000");
    expect(next.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

    // Custom port
    const custom = await getWithOrigin(app, "http://localhost:4200");
    expect(custom.headers["access-control-allow-origin"]).toBe("http://localhost:4200");
  });
});

// ============================================================================
// Real-world deployment scenarios
// ============================================================================

describe("CORS real-world scenarios", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("SaaS multi-tenant: allow all subdomains + localhost for dev", async () => {
    app = await buildApp({
      origin: [/^https:\/\/.*\.myapp\.com$/, "http://localhost:3000"],
      credentials: true,
    });

    const tenant1 = await getWithOrigin(app, "https://acme.myapp.com");
    expect(tenant1.headers["access-control-allow-origin"]).toBe("https://acme.myapp.com");
    expect(tenant1.headers["access-control-allow-credentials"]).toBe("true");

    const tenant2 = await getWithOrigin(app, "https://globex.myapp.com");
    expect(tenant2.headers["access-control-allow-origin"]).toBe("https://globex.myapp.com");

    const local = await getWithOrigin(app, "http://localhost:3000");
    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

    const denied = await getWithOrigin(app, "https://phishing.com");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("Mobile app API: no CORS needed (non-browser clients)", async () => {
    app = await buildApp(false);

    // No origin header = no CORS headers needed
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("Public API with no credentials: wildcard is fine", async () => {
    app = await buildApp({ origin: "*" });

    const res = await getWithOrigin(app, "https://anyone.com");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("Render/Vercel deployment: specific domain + credentials", async () => {
    app = await buildApp({
      origin: ["https://myapp.vercel.app", "https://custom-domain.com"],
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      allowedHeaders: ["Content-Type", "Authorization", "x-organization-id"],
    });

    const vercel = await getWithOrigin(app, "https://myapp.vercel.app");
    expect(vercel.headers["access-control-allow-origin"]).toBe("https://myapp.vercel.app");
    expect(vercel.headers["access-control-allow-credentials"]).toBe("true");

    const custom = await getWithOrigin(app, "https://custom-domain.com");
    expect(custom.headers["access-control-allow-origin"]).toBe("https://custom-domain.com");

    const denied = await getWithOrigin(app, "https://attacker.com");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("Vercel preview deployments: regex for dynamic subdomains", async () => {
    app = await buildApp({
      origin: [
        "https://myapp.vercel.app",
        /^https:\/\/myapp-.*\.vercel\.app$/, // Preview deployments
      ],
      credentials: true,
    });

    const main = await getWithOrigin(app, "https://myapp.vercel.app");
    expect(main.headers["access-control-allow-origin"]).toBe("https://myapp.vercel.app");

    const preview = await getWithOrigin(app, "https://myapp-abc123.vercel.app");
    expect(preview.headers["access-control-allow-origin"]).toBe("https://myapp-abc123.vercel.app");
  });
});
