/**
 * ONE assertion, run through EVERY surface arc exposes.
 *
 * Arc serves the same resource over HTTP and over MCP, through two different
 * entry paths that re-implement the same decisions: resolve identity into a
 * `RequestScope`, run the permission check, project fields, shape the error.
 * The suite tests those decisions 203 times on HTTP and 33 times on MCP — and
 * only twice on both. Every cross-surface defect this session lived in exactly
 * that gap: MCP dropped `teamId` from member scopes, and MCP's field masking
 * diverged from HTTP's, and in each case the HTTP test was green.
 *
 * A parity test is not "an MCP test too". It is the SAME expectation with the
 * transport as a parameter, so a divergence cannot be green anywhere.
 *
 * SCOPE — this is about BEHAVIOUR. Whether a route/action/aggregation is
 * DESCRIBED consistently across registry / OpenAPI / CLI describe / MCP is
 * `tests/contract/cross-surface.test.ts`. Complements, not duplicates: a tool
 * can be perfectly described and still skip its permission check.
 *
 *   forEachSurface("denies an anonymous list", async (surface) => {
 *     const r = await surface.call({ op: "list" }, ANONYMOUS);
 *     expect(r.status).toBe(401);
 *   });
 *
 * WHY normalize to an HTTP-shaped `{ status, ok, body }` rather than invent a
 * neutral third vocabulary: arc's error envelope (`{ code, message, status }`)
 * is already the shared contract — MCP embeds that exact object in its
 * `isError` text. The normalization therefore reads a value both surfaces
 * genuinely produce instead of inventing one, so a parity failure means the
 * surfaces disagree, not that the harness mistranslated.
 */

import type { FastifyRequest } from "fastify";
import { describe, it } from "vitest";
import type { ResourceDefinition } from "../../src/core/defineResource.js";
import { buildScope } from "../../src/integrations/mcp/buildRequestContext.js";
import { resourceToTools } from "../../src/integrations/mcp/resourceToTools.js";
import { arcApp } from "./app.js";

type AnyRecord = Record<string, unknown>;

// ── Identity ────────────────────────────────────────────────────────────

/**
 * The identity facts BOTH surfaces carry. Deliberately the intersection, not
 * the union: anything only one transport can express cannot be asserted at
 * parity, and pretending otherwise would hide the very gaps this file exists
 * to find.
 */
export interface Identity {
  readonly userId?: string;
  readonly roles?: string[];
  readonly orgId?: string;
  readonly teamId?: string;
}

/** No credentials at all — the case a permission test must actually reject. */
export const ANONYMOUS = null;

export type MaybeIdentity = Identity | typeof ANONYMOUS;

// ── Calls + results ─────────────────────────────────────────────────────

export type Op = "list" | "get" | "create" | "update" | "delete";

export interface SurfaceCall {
  readonly op: Op;
  readonly id?: string;
  readonly body?: AnyRecord;
  /** List-only query params (`?limit=5`). Ignored by ops that take no query. */
  readonly query?: Record<string, string>;
}

export interface SurfaceResult {
  /** HTTP status, or the `status` arc embedded in the MCP error envelope. */
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

/**
 * A declarative action (`resource.actions`), which the two surfaces expose in
 * genuinely different SHAPES: HTTP mounts every action of a resource at one
 * `POST <prefix>/:id/action` endpoint discriminated by an `action` field in
 * the body, while MCP emits one tool PER action. Same permission chain, same
 * handler, different addressing — which is exactly why it needs pinning: a
 * guard added to one shape is easy to forget in the other.
 */
export interface ActionCall {
  readonly action: string;
  readonly id?: string;
  readonly body?: AnyRecord;
}

/**
 * A custom route (`resource.routes`). The third tool family, and the one with
 * the worst track record: 2.11.x exposed these as MCP tools that ignored
 * `route.permissions` entirely, so a route gated over REST was callable
 * anonymously over MCP.
 *
 * `path` is the route's DECLARED path (`/export`, `/:id/publish`) — the same
 * string that identifies the generated tool, so both surfaces address the
 * route by the author's own vocabulary.
 */
export interface RouteCall {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly id?: string;
  readonly body?: AnyRecord;
}

export interface Surface {
  readonly name: "http" | "mcp";
  call(call: SurfaceCall, as?: MaybeIdentity): Promise<SurfaceResult>;
  callAction(call: ActionCall, as?: MaybeIdentity): Promise<SurfaceResult>;
  callRoute(call: RouteCall, as?: MaybeIdentity): Promise<SurfaceResult>;
}

// ── HTTP ────────────────────────────────────────────────────────────────

/**
 * Both surfaces are seeded from ONE `buildScope()` call.
 *
 * This is the load-bearing decision in the file. The obvious alternative —
 * set `request.user` on HTTP and pass a session to MCP — looks equivalent and
 * is not: on HTTP the `member` scope is minted by the AUTH PLUGIN
 * (`authPlugin.ts`), while MCP mints it straight from the session with no
 * plugin involved. With `auth: false` the same identity therefore yields a
 * member scope on MCP and a public one on HTTP, and every tenancy assertion
 * "diverges" for a reason that has nothing to do with the surfaces.
 *
 * Holding the RequestScope identical is what makes the remaining differences
 * attributable to the transport. Testing scope DERIVATION is a separate job,
 * and belongs with the auth plugin that owns it.
 */
function identityPreHandler(as: MaybeIdentity) {
  return async (request: FastifyRequest) => {
    if (!as) return;
    const user: AnyRecord = { id: as.userId, _id: as.userId, roles: as.roles ?? [] };
    if (as.orgId) user.organizationId = as.orgId;
    if (as.teamId) user.teamId = as.teamId;
    request.user = user;
    request.scope = buildScope(toSession(as));
  };
}

/** The one identity → MCP session mapping, shared by both surfaces. */
function toSession(as: MaybeIdentity) {
  if (!as) return null;
  return {
    userId: as.userId,
    roles: as.roles ?? [],
    ...(as.orgId ? { organizationId: as.orgId } : {}),
    ...(as.teamId ? { teamId: as.teamId } : {}),
  };
}

const HTTP_ROUTE: Record<Op, { method: "GET" | "POST" | "PATCH" | "DELETE"; withId: boolean }> = {
  list: { method: "GET", withId: false },
  get: { method: "GET", withId: true },
  create: { method: "POST", withId: false },
  // PATCH is arc's DEFAULT_UPDATE_METHOD; a resource setting `updateMethod`
  // is out of scope for parity and should assert on HTTP directly.
  update: { method: "PATCH", withId: true },
  delete: { method: "DELETE", withId: true },
};

async function httpSurface(makeResource: () => ResourceDefinition): Promise<Surface> {
  /** One boot + inject, shared by the CRUD and action entry points. */
  async function request(
    as: MaybeIdentity,
    build: (prefix: string) => {
      method: "GET" | "POST" | "PATCH" | "DELETE";
      url: string;
      payload?: AnyRecord;
    },
  ): Promise<SurfaceResult> {
    const resource = makeResource();
    const app = await arcApp({
      resources: [resource],
      plugins: async (fastify) => {
        fastify.addHook("preHandler", identityPreHandler(as));
      },
    } as never);

    const prefix = (resource as unknown as { prefix?: string }).prefix ?? `/${resource.name}`;
    const { method, url, payload } = build(prefix);
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });

    let body: unknown;
    try {
      body = res.body ? res.json() : undefined;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, ok: res.statusCode < 400, body };
  }

  return {
    name: "http",
    call(call, as = ANONYMOUS) {
      return request(as, (prefix) => {
        const route = HTTP_ROUTE[call.op];
        const search = new URLSearchParams(call.query ?? {}).toString();
        return {
          method: route.method,
          url: `${prefix}${route.withId ? `/${call.id ?? "missing"}` : ""}${search ? `?${search}` : ""}`,
          payload: call.body,
        };
      });
    },
    callAction(call, as = ANONYMOUS) {
      return request(as, (prefix) => ({
        method: "POST",
        // The id-less mount is a DIFFERENT endpoint, not the same one with an
        // empty segment — arc rejects an action submitted to the wrong mount.
        url: `${prefix}${call.id ? `/${call.id}/action` : "/action"}`,
        payload: { action: call.action, ...(call.body ?? {}) },
      }));
    },
    callRoute(call, as = ANONYMOUS) {
      return request(as, (prefix) => ({
        method: call.method,
        url: `${prefix}${call.path.replace(":id", call.id ?? "missing")}`,
        payload: call.body,
      }));
    },
  };
}

// ── MCP ─────────────────────────────────────────────────────────────────

/**
 * Resolve by `source` (`crud:<res>:<op>` / `action:<res>:<name>`), never by
 * tool NAME: names are pluralized, prefixable, and host-overridable, so a
 * rename would silently select the wrong tool — or none — and read as a
 * parity failure. `source` is the stable identity.
 */
function findToolBySource(tools: ReturnType<typeof resourceToTools>, want: string) {
  const tool = tools.find((t) => (t as unknown as { source?: string }).source === want);
  if (!tool) throw new Error(`[parity] no MCP tool with source '${want}'`);
  return tool;
}

/**
 * The app-level services a real MCP call gets, mirrored from `mcpPlugin`.
 *
 * WITHOUT this, `buildContextExtras` bails on `if (!wiring) return undefined`
 * and never stamps `metadata.arc` — which silently disables hooks, CRUD event
 * publishing, AND `BodySanitizer`'s field-WRITE enforcement, since that half
 * is gated on `arcContext?.arc?.fields`. A wiring-less MCP surface therefore
 * looks like it diverges from HTTP on writes when the real one does not: the
 * harness would be manufacturing its own parity failures.
 *
 * Lazy getters for the same reason the plugin uses them — registration order
 * must not decide whether execution finds its services.
 */
function wiringFrom(app: ArcApp) {
  const decorated = app as unknown as {
    arc?: { hooks?: unknown };
    events?: unknown;
    audit?: unknown;
    idempotency?: { store?: unknown };
  };
  return {
    get hooks() {
      return decorated.arc?.hooks;
    },
    get events() {
      return decorated.events;
    },
    get audit() {
      return decorated.audit;
    },
    get log() {
      return app.log;
    },
    get idempotencyStore() {
      return decorated.idempotency?.store;
    },
  };
}

function mcpSurface(makeResource: () => ResourceDefinition): Surface {
  /** One tool lookup + invoke, shared by the CRUD and action entry points. */
  async function invoke(
    as: MaybeIdentity,
    pick: (resource: ResourceDefinition) => string,
    input: AnyRecord,
  ): Promise<SurfaceResult> {
    const resource = makeResource();
    // Boot the app the tools belong to — production builds tools from
    // resources that are REGISTERED, and the wiring comes off that instance.
    const app = await arcApp({ resources: [resource] } as never);
    const tool = findToolBySource(
      resourceToTools(resource, { wiring: wiringFrom(app) }),
      pick(resource),
    );

    const raw = (await tool.handler(input, { session: toSession(as) } as never)) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };

    const text = raw.content?.[0]?.text;
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON tool text is returned verbatim */
    }

    // Arc's MCP errors ARE the HTTP envelope, so `status` reads straight
    // across. The 500 fallback only fires for a non-envelope throw.
    const status = raw.isError
      ? Number((body as { status?: unknown } | undefined)?.status ?? 500)
      : 200;
    return { status, ok: !raw.isError, body };
  }

  return {
    name: "mcp",
    call(call, as = ANONYMOUS) {
      const input: AnyRecord = { ...(call.body ?? {}), ...(call.query ?? {}) };
      if (call.id !== undefined) input.id = call.id;
      return invoke(as, (r) => `crud:${r.name}:${call.op}`, input);
    },
    callAction(call, as = ANONYMOUS) {
      // No `action` discriminator here: on MCP the action IS the tool, so the
      // field HTTP needs in its body would be stray input against a strict
      // schema. That asymmetry is the shape difference, not a divergence.
      const input: AnyRecord = { ...(call.body ?? {}) };
      if (call.id !== undefined) input.id = call.id;
      return invoke(as, (r) => `action:${r.name}:${call.action}`, input);
    },
    callRoute(call, as = ANONYMOUS) {
      const input: AnyRecord = { ...(call.body ?? {}) };
      if (call.id !== undefined) input.id = call.id;
      // `route:<res>:<METHOD> <path>` — the DECLARED path, un-substituted, so
      // the id stays a tool argument here while HTTP puts it in the URL.
      return invoke(as, (r) => `route:${r.name}:${call.method} ${call.path}`, input);
    },
  };
}

// ── The driver ──────────────────────────────────────────────────────────

/**
 * Run one body of assertions against every surface.
 *
 * `makeResource` is a FACTORY, not a resource: each surface (and each call)
 * gets a fresh definition, so a mutation made through HTTP cannot leak into
 * the MCP run and turn a real divergence into a passing test.
 */
export function forEachSurface(
  title: string,
  makeResource: () => ResourceDefinition,
  body: (surface: Surface) => Promise<void> | void,
): void {
  describe(title, () => {
    const build: Array<[string, () => Promise<Surface>]> = [
      ["http", () => httpSurface(makeResource)],
      ["mcp", async () => mcpSurface(makeResource)],
    ];
    for (const [name, make] of build) {
      it(`[${name}] ${title}`, async () => {
        await body(await make());
      });
    }
  });
}
