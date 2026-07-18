/**
 * Realtime Plugin — permission-aware resource change subscriptions.
 *
 * `GET /realtime/:resource` (`:resource` = the resource NAME — the
 * singular registry key, same identity MCP tools and introspection use,
 * NOT the pluralized route prefix) streams that resource's CRUD events
 * (`{resource}.created/.updated/.deleted`, emitted by arc's own event
 * bridge) over SSE, gated and filtered by the SAME machinery that guards
 * the REST routes:
 *
 *   1. CONNECT gate — the resource's `list` permission runs once (same
 *      check, same 401/403 shapes). Its row filters (`_policyFilters`)
 *      are snapshotted for the connection.
 *   2. PER-EVENT row filtering — each event's document is matched against
 *      the snapshot IN PROCESS (adapter `matchesFilter` when the kit
 *      supplies one, `simpleEqualityMatcher` for flat-equality filters).
 *      No per-event DB round-trip, no client-side N+1 `stat` calls.
 *   3. TENANT guard — events carrying an `organizationId` only reach
 *      subscribers whose scope matches (fail-closed for org-less callers),
 *      unless the resource declared `tenantField: false`.
 *   4. FIELD masking — `applyFieldReadPermissions` runs on every payload
 *      with the subscriber's roles, so hidden/role-gated fields never
 *      reach the wire. The registry's live `fields` map powers this.
 *
 * FAIL-CLOSED contract: operator-shaped filters (`$or`/`$in`, e.g. from
 * `requireGrant` list resolutions) without an adapter `matchesFilter`
 * REJECT the subscription at connect (501 + fix hint) — never silently
 * deliver unfiltered rows. Events whose payload can't be matched are
 * dropped.
 *
 * MULTIPLEXING (Mercure-style): `GET /realtime?resources=a,b,c` carries N
 * feeds over ONE connection (cap {@link MAX_MULTIPLEX_RESOURCES}) — the
 * Phoenix-channels/Pusher concern answered at the URL level, no custom
 * protocol. Each resource is authorized independently with an ISOLATED
 * filter snapshot; any denial rejects the whole subscription. Frames are
 * SSE-standard: per-frame `id:` (client `lastEventId` dedup) + a `retry:`
 * hint at connect.
 *
 * MEMBERSHIP TRANSITIONS: when an UPDATE moves a record OUT of a
 * subscriber's row filter (owner reassigned, soft-deleted, moved org), the
 * feed emits a synthetic `<resource>.left` frame (`{ id }`) so the client
 * drops the now-invisible row — the "row left the result set" signal every
 * mature realtime system sends (Firestore `removed`, ElectricSQL move-out,
 * Meteor `removed`, RethinkDB `remove`). The ENTER transition needs no
 * special frame — the matching `updated` frame carries the full record.
 *
 * STALENESS BOUND: row filters are snapshotted at connect, so a caller
 * whose permissions are revoked mid-connection keeps their old view until
 * reconnect. The feed force-closes at the auth token's `exp` (→ reconnect →
 * fresh authorization); `maxConnectionMs` caps this for session/cookie auth
 * with no `exp`. Same posture as Supabase's JWT-TTL-bounded Broadcast.
 *
 * Deliberate NON-goals (keep the surface honest):
 *   - No replay/resume — reconnecting clients refetch the list; the feed
 *     is a change NOTIFIER, not an event store (use the outbox for
 *     guaranteed delivery).
 *   - Filters must be CONCRETE at connect (arc's permission helpers resolve
 *     grant/tenant ids into literal values). A filter referencing a related
 *     row NOT present in the event payload can't be evaluated in-process —
 *     encode such rules as data on the record, or accept the DB-list view.
 *   - No presence/broadcast — `app.events` + the sse plugin already cover
 *     custom channels.
 *   - No payload E2EE — TLS + per-subscriber field masking is the wire
 *     posture (industry-consistent: Supabase/Pusher ship no realtime
 *     payload encryption; Signal-style E2EE is for user-to-user messaging,
 *     not server-authoritative feeds).
 *   - Delivery is per-instance at-most-once over the event transport's
 *     semantics (memory: this instance; Redis Streams: at-least-once).
 *
 * @example
 * ```ts
 * const app = await createApp({
 *   arcPlugins: { realtime: true },   // or { path, heartbeat, resources: [...] }
 *   resources: [orderResource],
 * });
 * // Browser:
 * new EventSource(`/realtime/order?token=${jwt}`)   // resource NAME
 *   .addEventListener('order.updated', (e) => render(JSON.parse(e.data)));
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { DomainEvent } from "../events/EventTransport.js";
import { arcLog } from "../logger/index.js";
import { evaluateAndApplyPermission } from "../permissions/applyPermissionResult.js";
import { applyFieldReadPermissions } from "../permissions/fields.js";
import type { UserBase } from "../permissions/types.js";
import { getUserRoles } from "../permissions/types.js";
import type { RequestScope } from "../scope/types.js";
import { getOrgId } from "../scope/types.js";
import type { RegistryEntry } from "../types/index.js";
import { simpleEqualityMatcher } from "../utils/simpleEqualityMatcher.js";
import { openSseStream } from "../utils/sseStream.js";
import { promoteStreamTokenToHeader } from "../utils/streaming.js";

const log = arcLog("realtime");

const CHANGE_OPERATIONS = ["created", "updated", "deleted"] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

/**
 * SSE `retry:` reconnection hint (ms). Deliberate: the feed has no replay,
 * so a reconnecting client refetches the list anyway — a short retry keeps
 * the gap small without hammering the server.
 */
const DEFAULT_RETRY_MS = 3_000;

/**
 * Cap on resources per multiplexed connection. Generous for real
 * dashboards (Supabase caps channels-per-client similarly); prevents a
 * single socket from fanning out unbounded subscription work.
 */
const MAX_MULTIPLEX_RESOURCES = 20;

export interface RealtimeOptions {
  /**
   * Route path — must contain `:resource` (default: `/realtime/:resource`).
   */
  path?: string;
  /** Heartbeat interval in ms (default: 30000). */
  heartbeat?: number;
  /**
   * Subscribable resources. Default: every registered resource — safe
   * because each subscription runs that resource's own `list` permission;
   * narrow it when only some resources should have a change feed at all.
   */
  resources?: readonly string[];
  /** Operations streamed (default: created + updated + deleted). */
  operations?: readonly ChangeOperation[];
  /**
   * Query parameter carrying the bearer token for browser `EventSource`
   * clients (default `'token'`, matching the sse plugin / arc-next).
   * Set `null` to disable promotion.
   */
  tokenQueryParam?: string | null;
  /**
   * Hard ceiling (ms) on any single connection's lifetime. Bounds
   * permission STALENESS: the row filters are snapshotted at connect, so a
   * caller whose permissions are revoked mid-connection keeps receiving
   * their old view until they reconnect. Independently, arc ALWAYS closes
   * the feed when the auth token's `exp` passes (forcing reconnect +
   * re-authorization with fresh filters) — this option adds a cap for
   * session/cookie auth that carries no `exp`, or to tighten below the
   * token TTL. Omit for token-exp-only bounding.
   */
  maxConnectionMs?: number;
}

/** Kit adapters may supply a dialect-aware in-process filter matcher. */
interface MatchingAdapter {
  matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;
}

/** Node's `setTimeout` ceiling (~24.8 days); larger delays fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Milliseconds from `now` until the feed should force-close to bound
 * permission staleness — `min(auth-token exp, maxConnectionMs)`. Returns
 * `undefined` when neither bound applies (no `exp` claim, no cap → the feed
 * lives until client disconnect), `0` when already expired, else the
 * (setTimeout-ceiling-clamped) delay. Pure; exported for tests.
 */
export function connectionDeadlineMs(
  user: unknown,
  maxConnectionMs: number | undefined,
  now: number = Date.now(),
): number | undefined {
  let deadline: number | undefined;
  const exp = (user as { exp?: unknown } | null | undefined)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) {
    deadline = exp * 1000 - now; // JWT `exp` is seconds since epoch
  }
  if (maxConnectionMs !== undefined && maxConnectionMs > 0) {
    deadline = deadline === undefined ? maxConnectionMs : Math.min(deadline, maxConnectionMs);
  }
  if (deadline === undefined) return undefined;
  if (deadline <= 0) return 0;
  return Math.min(deadline, MAX_TIMER_MS);
}

// ============================================================================
// Pure policy — exported for unit tests (same convention as
// `buildGeneratedCrudSchemas`); the handler below is orchestration only.
// ============================================================================

/**
 * Are these filters flat equality (every value a scalar, no `$` operators)?
 * That is the shape `simpleEqualityMatcher` is safe for — anything richer
 * needs the adapter's own matcher.
 */
function isFlatEquality(filters: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key.startsWith("$")) return false;
    if (value !== null && typeof value === "object" && !(value instanceof Date)) return false;
  }
  return true;
}

/** Row-filter enforcement decision for one subscription. */
export type RowMatcherResolution =
  | { enforceable: true; matcher?: (item: unknown, filters: Record<string, unknown>) => boolean }
  | { enforceable: false };

/**
 * Decide how (or whether) this subscription's row filters can be enforced
 * in process: adapter matcher when supplied, `simpleEqualityMatcher` for
 * flat-equality shapes, UNENFORCEABLE (fail-closed → 501) for
 * operator-shaped filters with no adapter matcher. No filters → nothing
 * to enforce.
 */
export function resolveRowMatcher(
  filters: Record<string, unknown> | undefined,
  adapter: MatchingAdapter | undefined,
): RowMatcherResolution {
  const hasFilters = !!filters && Object.keys(filters).length > 0;
  if (adapter?.matchesFilter) {
    const matcher = adapter.matchesFilter.bind(adapter);
    // Probe the filter ONCE at connect against an empty doc so an
    // unsupported operator (a custom permission returning `$elemMatch`,
    // `$where`, …) surfaces as a clean connect-time rejection (→ 501)
    // instead of THROWING per-event mid-stream — which would crash the
    // subscriber's feed on the first matching write. An empty doc can't
    // trip a value-dependent error but does exercise the matcher's
    // operator-support path.
    if (hasFilters && filters) {
      try {
        matcher({}, filters);
      } catch {
        return { enforceable: false };
      }
    }
    return { enforceable: true, matcher };
  }
  if (!hasFilters) return { enforceable: true };
  if (isFlatEquality(filters)) return { enforceable: true, matcher: simpleEqualityMatcher };
  return { enforceable: false };
}

/** Everything a delivery decision needs — snapshotted once per connection. */
export interface DeliveryPolicy {
  tenantScoped: boolean;
  subscriberOrgId: string | undefined;
  filters: Record<string, unknown> | undefined;
  matcher: ((item: unknown, filters: Record<string, unknown>) => boolean) | undefined;
}

/** The three outcomes for one event × one subscriber. */
export type DeliveryDecision =
  /** Send the change frame (create / update / delete the subscriber can see). */
  | { kind: "deliver"; doc: unknown }
  /**
   * Send a synthetic `<resource>.left` (id only): a record the subscriber
   * COULD have been shown was UPDATED such that it no longer matches their
   * row filter (reassigned owner, soft-deleted, moved org). Without this the
   * subscriber's UI keeps a stale row forever — the "row left the result
   * set" problem every mature realtime system signals (Firestore `removed`,
   * ElectricSQL move-out, Meteor `removed`, RethinkDB `remove`).
   */
  | { kind: "leave" }
  /** Nothing to send — never visible to this subscriber. */
  | { kind: "drop" };

/**
 * Decide this event's fate for one subscriber. Pure — the whole
 * authorization + membership-transition story lives here:
 *
 *   1. tenant guard: org-carrying events only reach matching-org subscribers
 *      (a cross-org record was never visible → drop, never a leave).
 *   2. row filters (connect-time snapshot):
 *      - matches (or no filters)                     → deliver.
 *      - no match + operation is `updated`           → LEAVE (membership
 *        transition out; the record may have been in the subscriber's view).
 *      - no match + operation is `created`/`deleted` → drop (never entered
 *        the view — a created record that doesn't match was never shown; a
 *        deleted record that doesn't match was already filtered out).
 *
 * The ENTER transition (a record updated so it now DOES match) needs no
 * special signal: the matching `updated` frame carries the full record, so
 * the client adds it if absent.
 */
export function resolveDelivery(
  event: DomainEvent<unknown>,
  policy: DeliveryPolicy,
  operation: ChangeOperation,
): DeliveryDecision {
  if (policy.tenantScoped) {
    const eventOrgId = event.meta?.organizationId;
    if (eventOrgId && eventOrgId !== policy.subscriberOrgId) return { kind: "drop" };
  }

  const doc = (event.payload as { data?: unknown } | undefined)?.data;
  const hasFilters = !!policy.filters && Object.keys(policy.filters).length > 0;
  if (!hasFilters) return { kind: "deliver", doc };

  const matches =
    !!doc &&
    typeof doc === "object" &&
    !!policy.matcher?.(doc, policy.filters as Record<string, unknown>);
  if (matches) return { kind: "deliver", doc };

  return operation === "updated" ? { kind: "leave" } : { kind: "drop" };
}

/**
 * Build the wire frame for one delivered change. Envelope note: this is
 * deliberately DOCUMENT-CHANGE-shaped (`data` = the masked document),
 * unlike the sse plugin's raw event mirror (`payload` = whatever was
 * published) — the two streams serve different consumers and the
 * divergence is intentional, not drift.
 */
export function buildChangeFrame(
  event: DomainEvent<unknown>,
  resourceName: string,
  data: unknown,
): string {
  return JSON.stringify({
    type: event.type,
    resource: resourceName,
    id: event.meta?.resourceId,
    data,
    meta: {
      timestamp: event.meta?.timestamp,
      correlationId: event.meta?.correlationId,
    },
  });
}

const realtimePlugin: FastifyPluginAsync<RealtimeOptions> = async (
  fastify: FastifyInstance,
  opts: RealtimeOptions = {},
) => {
  const {
    path = "/realtime/:resource",
    heartbeat = 30_000,
    resources: allowlist,
    operations = CHANGE_OPERATIONS,
    tokenQueryParam = "token",
    maxConnectionMs,
  } = opts;

  if (!fastify.hasDecorator("events")) {
    log.warn(
      "Events plugin (arc-events) not registered. Realtime plugin will not function. " +
        "Register eventPlugin before realtimePlugin.",
    );
    return;
  }
  if (!path.includes(":resource")) {
    throw new Error(`[arc-realtime] path must contain ':resource' (got '${path}')`);
  }

  const activeConnections = new Set<() => void>();

  /** One authorized resource on a connection: everything delivery needs. */
  interface ResourceSubscription {
    name: string;
    policy: DeliveryPolicy;
    fields: RegistryEntry["fields"];
  }

  const isProtected = (entry: RegistryEntry): boolean => {
    const listCheck = entry.permissions?.list;
    return (
      typeof listCheck === "function" && (listCheck as { _isPublic?: boolean })._isPublic !== true
    );
  };

  /**
   * Run auth once for a set of requested resources: `authenticate` when ANY
   * is protected (401 on missing/invalid token), `optionalAuthenticate`
   * otherwise so tokens still parse. Returns false when a reply was sent.
   */
  const runAuth = async (
    request: FastifyRequest,
    reply: FastifyReply,
    entries: RegistryEntry[],
  ): Promise<boolean> => {
    const needsAuth = entries.some(isProtected);
    if (tokenQueryParam) promoteStreamTokenToHeader(request, tokenQueryParam);
    const authenticate = (needsAuth ? fastify.authenticate : fastify.optionalAuthenticate) as
      | ((req: FastifyRequest, rep: FastifyReply) => Promise<void>)
      | undefined;
    if (needsAuth && typeof authenticate !== "function") {
      await reply
        .code(401)
        .send({ code: "arc.unauthorized", message: "Authentication required", status: 401 });
      return false;
    }
    if (typeof authenticate === "function") {
      await authenticate(request, reply);
      if (reply.sent) return false;
    }
    return true;
  };

  /**
   * Authorize ONE resource for this connection: run its list permission,
   * snapshot its row filters IN ISOLATION (evaluateAndApplyPermission
   * accumulates onto request._policyFilters — on a multiplexed connection
   * resource B must never inherit resource A's filters, so the field is
   * saved/reset/restored around each evaluation), and resolve the row
   * matcher fail-closed. Sends the denial/501 reply itself; returns null
   * when the caller should stop.
   */
  const authorizeResource = async (
    resourceName: string,
    entry: RegistryEntry,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ResourceSubscription | null> => {
    const holder = request as { _policyFilters?: Record<string, unknown> };
    const saved = holder._policyFilters;
    holder._policyFilters = undefined;
    try {
      const listCheck = entry.permissions?.list;
      if (typeof listCheck === "function") {
        const authorized = await evaluateAndApplyPermission(
          listCheck,
          {
            user: (request.user as UserBase | null) ?? null,
            request,
            resource: resourceName,
            action: "list",
          },
          request,
          reply,
        );
        if (!authorized) return null;
      }

      const filters = holder._policyFilters;
      const resolution = resolveRowMatcher(
        filters,
        fastify.arc?.registry?.getAdapter<MatchingAdapter>(resourceName),
      );
      if (!resolution.enforceable) {
        // Operator-shaped filters (requireGrant $or/$in, custom checks)
        // can't be enforced in-process without the kit's matcher. Reject
        // loudly — silently unfiltered delivery would be a data leak.
        await reply.code(501).send({
          code: "arc.realtime.unfilterable",
          message:
            `The '${resourceName}' list permission returned operator-shaped row filters, ` +
            "which this feed cannot enforce in-process. Supply `matchesFilter` on the " +
            "resource's DataAdapter to enable realtime for filter-scoped subscribers.",
          status: 501,
        });
        return null;
      }

      const scope: RequestScope | undefined = request.scope;
      return {
        name: resourceName,
        policy: {
          tenantScoped: entry.tenantField !== false,
          subscriberOrgId: scope ? getOrgId(scope) : undefined,
          filters,
          matcher: resolution.matcher,
        },
        fields: entry.fields,
      };
    } finally {
      holder._policyFilters = saved;
    }
  };

  /** Open the stream and wire every authorized subscription onto it. */
  // Fan-out cost control: for subscribers with NO field masking the frame
  // is byte-identical, so serialize ONCE per event and share across every
  // such subscriber (WeakMap — entries die with the event object). Masked
  // subscribers pay their own stringify; masking is per-role by nature.
  const sharedFrames = new WeakMap<object, string>();

  const streamSubscriptions = async (
    request: FastifyRequest,
    reply: FastifyReply,
    subscriptions: ResourceSubscription[],
  ): Promise<void> => {
    const userRoles = getUserRoles((request.user ?? {}) as UserBase);
    const stream = openSseStream(request, reply, {
      heartbeatMs: heartbeat,
      retryMs: DEFAULT_RETRY_MS,
    });
    stream.onCleanup(() => activeConnections.delete(stream.close));
    activeConnections.add(stream.close);

    // Bound permission STALENESS: filters are snapshotted at connect, so a
    // revoked caller keeps their old view until reconnect. Close the feed
    // at the auth token's `exp` (forces reconnect → fresh authorization) —
    // capped by `maxConnectionMs` when set (and the sole bound for session
    // auth carrying no `exp`). Same posture as Supabase's JWT-TTL-bounded
    // Broadcast channels.
    const closeAt = connectionDeadlineMs(request.user, maxConnectionMs);
    if (closeAt !== undefined) {
      if (closeAt <= 0) {
        stream.close();
        return;
      }
      const timer = setTimeout(stream.close, closeAt);
      timer.unref?.();
      stream.onCleanup(() => clearTimeout(timer));
    }

    for (const sub of subscriptions) {
      const deliver = (event: DomainEvent<unknown>, operation: ChangeOperation): void => {
        const decision = resolveDelivery(event, sub.policy, operation);
        if (decision.kind === "drop") return;
        if (decision.kind === "leave") {
          // Membership transition OUT — tell the client to drop the row.
          // Id only; no document, no masking (nothing to leak).
          stream.write(
            `${sub.name}.left`,
            JSON.stringify({
              type: `${sub.name}.left`,
              resource: sub.name,
              id: event.meta?.resourceId,
            }),
            event.meta?.id,
          );
          return;
        }
        const { doc } = decision;
        const needsMask = !!sub.fields && !!doc && typeof doc === "object";
        let frame: string;
        if (needsMask) {
          const masked = applyFieldReadPermissions(
            doc as Record<string, unknown>,
            sub.fields as NonNullable<typeof sub.fields>,
            userRoles,
          );
          frame = buildChangeFrame(event, sub.name, masked);
        } else {
          const cached = sharedFrames.get(event as object);
          frame = cached ?? buildChangeFrame(event, sub.name, doc);
          if (!cached) sharedFrames.set(event as object, frame);
        }
        stream.write(event.type, frame, event.meta?.id);
      };
      for (const operation of operations) {
        const unsub = await fastify.events.subscribe(`${sub.name}.${operation}`, (event) =>
          deliver(event, operation),
        );
        stream.onCleanup(unsub);
      }
    }

    // Ready frame — clients know the subscription is live (and what it
    // carries) before the first change arrives.
    stream.write(
      "ready",
      JSON.stringify({
        resources: subscriptions.map((s) => s.name),
        operations: [...operations],
      }),
    );
  };

  const lookupEntry = (name: string): RegistryEntry | undefined => {
    if (allowlist && !allowlist.includes(name)) return undefined;
    return fastify.arc?.registry?.get(name);
  };

  const notFound = (reply: FastifyReply, name: string) =>
    reply.code(404).send({
      code: "arc.not_found",
      message: `Resource '${name}' has no realtime feed`,
      status: 404,
    });

  // ── Route 1: single resource — GET /realtime/:resource ────────────────
  fastify.route({
    method: "GET",
    url: path,
    schema: {
      tags: ["Events"],
      summary: "Realtime resource change feed",
      description:
        "SSE stream of created/updated/deleted events for one resource, gated by its " +
        "list permission — row filters and field-level read permissions apply per event.",
      response: { 200: { type: "string", description: "text/event-stream" } },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const resourceName = (request.params as { resource: string }).resource;
      const entry = lookupEntry(resourceName);
      if (!entry) return notFound(reply, resourceName);
      if (!(await runAuth(request, reply, [entry]))) return;
      const sub = await authorizeResource(resourceName, entry, request, reply);
      if (!sub) return;
      await streamSubscriptions(request, reply, [sub]);
    },
  });

  // ── Route 2: multiplexed — GET /realtime?resources=a,b,c ──────────────
  // Mercure-style topic multiplexing: ONE EventSource carries N resource
  // feeds (dashboards subscribe to many entities without burning
  // connections on HTTP/1.1; over HTTP/2 either form is fine). Each
  // resource is authorized INDEPENDENTLY with its own filter snapshot;
  // any denial rejects the whole subscription (explicit, fail-closed —
  // partial silent success would hide authorization bugs).
  const multiplexPath = path.replace(/\/:resource$/, "");
  fastify.route({
    method: "GET",
    url: multiplexPath,
    schema: {
      tags: ["Events"],
      summary: "Realtime multi-resource change feed",
      description:
        "Multiplexed SSE stream for several resources over one connection " +
        "(?resources=a,b,c). Every resource is gated by its own list permission; " +
        "any denial rejects the subscription.",
      querystring: {
        type: "object",
        properties: { resources: { type: "string" } },
        required: ["resources"],
      },
      response: { 200: { type: "string", description: "text/event-stream" } },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const raw = (request.query as { resources: string }).resources;
      const names = [
        ...new Set(
          raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      if (names.length === 0 || names.length > MAX_MULTIPLEX_RESOURCES) {
        return reply.code(400).send({
          code: "arc.bad_request",
          message: `resources must name 1–${MAX_MULTIPLEX_RESOURCES} registered resources`,
          status: 400,
        });
      }

      const entries: RegistryEntry[] = [];
      for (const name of names) {
        const entry = lookupEntry(name);
        if (!entry) return notFound(reply, name);
        entries.push(entry);
      }

      if (!(await runAuth(request, reply, entries))) return;

      const subscriptions: ResourceSubscription[] = [];
      for (let i = 0; i < names.length; i++) {
        const sub = await authorizeResource(
          names[i] as string,
          entries[i] as RegistryEntry,
          request,
          reply,
        );
        if (!sub) return; // denial reply already sent, names the resource
        subscriptions.push(sub);
      }

      await streamSubscriptions(request, reply, subscriptions);
    },
  });

  fastify.addHook("onClose", async () => {
    for (const close of activeConnections) close();
    activeConnections.clear();
  });

  log.debug("Plugin registered", { path, operations, allowlist });
};

export default fp(realtimePlugin, {
  name: "arc-realtime",
  fastify: "5.x",
  dependencies: ["arc-events"],
});

export { realtimePlugin };
