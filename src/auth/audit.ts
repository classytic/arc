/**
 * Better Auth → Arc Audit Bridge
 *
 * Routes Better Auth lifecycle events (sign-in, sign-up, sign-out, MFA,
 * org invitations, password reset, …) through arc's existing `auditPlugin`
 * — same wire shape, same store, same query API as resource audit rows.
 *
 * **Why a bridge, not a parallel store**: enterprises ask "list everything
 * user X did in the last 30 days" — that requires one collection, not two.
 * Auth events get `resource: 'auth'`, action = the BA event name (e.g.
 * `session.create`, `mfa.verify`), `documentId` = the subject id (user /
 * session / org id depending on event). Standard audit query helpers work.
 *
 * **Zero coupling to BA internals**: the bridge consumes the public BA
 * `hooks` + `databaseHooks` config — same surface BA users already wire
 * by hand. Arc adds nothing BA didn't already expose.
 *
 * @example
 * ```typescript
 * import { betterAuth } from 'better-auth';
 * import { organization, twoFactor } from 'better-auth/plugins';
 * import { wireBetterAuthAudit } from '@classytic/arc/auth/audit';
 *
 * const audit = wireBetterAuthAudit({
 *   events: ['session.*', 'user.create', 'mfa.*', 'org.invite.*'],
 * });
 *
 * const auth = betterAuth({
 *   plugins: [organization(), twoFactor()],
 *   hooks: audit.hooks,                 // endpoint hooks for MFA, OAuth, password reset
 *   databaseHooks: audit.databaseHooks, // DB hooks for sign-in/up/out via session.create/delete
 * });
 *
 * const app = await createApp({
 *   auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth }) },
 *   arcPlugins: { audit: { repository: auditRepo } },
 * });
 *
 * audit.attach(app);   // flushes any boot-time events + connects live logger
 * ```
 */

import type { FastifyInstance } from "fastify";

// ─────────────────────────────────────────────────────────────────────
// Public types — kept narrow; BA's own types are intentionally NOT
// imported. Bridge survives BA major upgrades because it relies on
// duck-typed shapes (matcher / handler), not nominal types.
// ─────────────────────────────────────────────────────────────────────

/**
 * Canonical auth event names emitted by the bridge. Hosts pattern-match
 * with glob (`session.*`, `mfa.*`, `*.failed`) when listing `events`.
 *
 * Names mirror BA's database-hook + endpoint-hook taxonomy. Not exhaustive —
 * unknown events still flow through when matched, just with the BA-supplied
 * name verbatim. Use this list for autocomplete-friendly defaults.
 */
export type AuthEventName =
  // Session lifecycle (database hooks)
  | "session.create" // sign-in success (any provider)
  | "session.delete" // sign-out
  | "session.update" // session refresh / org switch
  // User lifecycle (database hooks)
  | "user.create" // sign-up success
  | "user.update" // profile edit
  | "user.delete"
  // MFA / 2FA (endpoint hooks; require twoFactor plugin)
  | "mfa.enroll"
  | "mfa.verify"
  | "mfa.failed"
  | "mfa.disable"
  // Password & verification
  | "password.reset.request"
  | "password.reset.complete"
  | "email.verify"
  // Organization (require organization plugin)
  | "org.create"
  | "org.delete"
  | "org.invite.create"
  | "org.invite.accept"
  | "org.invite.reject"
  | "org.member.add"
  | "org.member.remove"
  | "org.member.role.update"
  // API keys (require @better-auth/api-key)
  | "apikey.create"
  | "apikey.delete"
  | "apikey.failed"
  // Generic catch-all — bridge emits these for unknown matched endpoints
  | "endpoint.before"
  | "endpoint.after"
  | "endpoint.error";

/**
 * Resolved auth event ready for audit. The bridge constructs this from
 * BA's hook context, then forwards to `app.audit.custom('auth', subjectId,
 * event.name, event.payload)`.
 */
export interface AuthEvent {
  /** Canonical name (see {@link AuthEventName}). */
  name: string;
  /**
   * Subject id — the user / session / org / invite id this event is about.
   * Empty string when the event is pre-creation (e.g. `mfa.failed` before
   * the session exists); audit rows accept empty `documentId`.
   */
  subjectId: string;
  /** User performing the action (when known); audit infers from request when omitted. */
  userId?: string;
  /** Organization context (when known). */
  organizationId?: string;
  /** Free-form payload — provider name, IP, user-agent, MFA method, etc. */
  payload?: Record<string, unknown>;
}

/**
 * Options for `wireBetterAuthAudit`.
 */
export interface WireBetterAuthAuditOptions {
  /**
   * Glob patterns selecting which events to audit. `*` matches a single
   * segment (`session.*` matches `session.create` but not `session.create.foo`),
   * `**` matches deeply. Defaults to `['session.*', 'user.create', 'user.delete']`
   * — the SOC2/HIPAA minimum. Pass `['**']` to audit everything.
   */
  events?: readonly string[];
  /**
   * Custom event-name resolver — invoked when the bridge can't classify
   * an endpoint hook firing. Return a string (used as the audit `action`)
   * to keep it; return `null` to drop. Default behaviour: emits
   * `endpoint.before` / `endpoint.after` / `endpoint.error` with the
   * matched path in `payload.path`.
   */
  resolveEndpointEvent?: (
    phase: "before" | "after" | "error",
    ctx: { path?: string; method?: string; error?: unknown },
  ) => string | null;
  /**
   * Maximum number of events to buffer before `attach(app)` is called.
   * Older events are dropped FIFO once full. Default 1000 — enough for
   * boot-time flow even on slow Fastify init paths.
   */
  bufferSize?: number;
  /**
   * Optional pre-flight transform — runs before the audit row is written.
   * Return `null` to drop the event; otherwise the returned event is
   * forwarded. Use to redact tokens, add custom payload fields, or
   * map BA-specific event names to your own taxonomy.
   */
  transform?: (event: AuthEvent) => AuthEvent | null | Promise<AuthEvent | null>;
}

/**
 * Result of `wireBetterAuthAudit` — duck-typed BA `hooks` + `databaseHooks`
 * config plus an `attach(app)` method to connect the live audit logger.
 */
export interface BetterAuthAuditBridge {
  /**
   * Spread into `betterAuth({ hooks })`. BA's top-level `hooks.before` /
   * `hooks.after` slots take a single async function each (not an array).
   * The bridge collapses its internal endpoint classifier into one dispatcher
   * per phase. Returns `{}` so BA's `runAfterHooks` reads `.headers` / `.response`
   * on a real object instead of crashing on undefined. For plugin-author array
   * form, see {@link asPluginHooks}.
   */
  hooks: {
    before: (ctx: BetterAuthHookContext) => Promise<Record<string, never>>;
    after: (ctx: BetterAuthHookContext) => Promise<Record<string, never>>;
  };
  /**
   * Plugin-form hooks — array of `{ matcher, handler }` entries suitable for
   * `betterAuth({ plugins: [{ id, hooks: bridge.asPluginHooks() }] })`. Use
   * when you're writing a BA plugin and want the audit dispatch to ride along
   * with your plugin's own hooks instead of occupying the top-level slot.
   */
  asPluginHooks(): {
    before: BetterAuthHookEntry[];
    after: BetterAuthHookEntry[];
  };
  /** Spread into `betterAuth({ databaseHooks })`. */
  databaseHooks: {
    user: {
      create: { after: (user: { id?: string }) => Promise<void> };
      update: { after: (user: { id?: string }) => Promise<void> };
      delete?: { after: (user: { id?: string }) => Promise<void> };
    };
    session: {
      create: { after: (session: SessionLike) => Promise<void> };
      update?: { after: (session: SessionLike) => Promise<void> };
      delete?: { after: (session: SessionLike) => Promise<void> };
    };
  };
  /**
   * Connect a live Fastify instance after boot. Buffered events from the
   * BA construction phase are flushed in order; subsequent events stream
   * through the connected `app.audit.custom(...)` directly.
   */
  attach(app: FastifyInstance): void;
  /**
   * Manual emit — for hosts that need to record auth events outside BA's
   * hook surface (e.g. webhook signature failures, custom MFA flows).
   */
  emit(event: AuthEvent): void;
  /**
   * Observability counters — surface to your metrics backend. Counters are
   * cumulative since bridge construction; reset when `wireBetterAuthAudit`
   * is called again. Useful for Prometheus exporters that scrape periodically.
   */
  getStats(): {
    /** Events buffered during pre-`attach` phase that were dropped due to `bufferSize` overflow. */
    droppedFromBuffer: number;
    /** Events that reached `app.audit.custom(...)` but threw (audit store failure). */
    dispatchFailures: number;
    /** Total `dispatch` calls — useful to verify BA is actually invoking the bridge's hooks. */
    dispatchAttempts: number;
    /** Events currently buffered awaiting `attach`. */
    pendingBuffered: number;
  };
}

/**
 * Single BA hook entry — duck-typed to avoid pinning a BA major version.
 * The shape mirrors `better-auth`'s public `hooks.{before,after}` API.
 */
export interface BetterAuthHookEntry {
  matcher: (ctx: BetterAuthHookContext) => boolean;
  /**
   * Returns a (possibly empty) object so BA's `runBeforeHooks` /
   * `runAfterHooks` can read `.headers` / `.response` off the result without
   * the `Cannot read properties of undefined` crash that hits when handlers
   * return `void`. The bridge always returns `{}` because it's a side-effect
   * dispatcher — no header rewrites or response substitution.
   */
  handler: (
    ctx: BetterAuthHookContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

/** Subset of BA's hook context the bridge actually reads. */
export interface BetterAuthHookContext {
  path?: string;
  method?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  context?: {
    session?: { user?: { id?: string }; activeOrganizationId?: string };
    request?: { ip?: string; headers?: Record<string, string | undefined> };
  };
  returned?: unknown;
  error?: unknown;
}

/** Subset of BA's session shape the bridge reads from databaseHooks. */
interface SessionLike {
  id?: string;
  userId?: string;
  activeOrganizationId?: string;
  ipAddress?: string;
  userAgent?: string;
  impersonatedBy?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Glob matcher — single segment `*`, deep `**`
// ─────────────────────────────────────────────────────────────────────

function compileGlobs(patterns: readonly string[]): (name: string) => boolean {
  if (patterns.length === 0) return () => false;
  // Glob → regex. `**` matches any chars (including dots); `*` matches a single
  // segment (no dots). Escape regex metachars on the literal portions only —
  // walking the pattern char-by-char avoids placeholder shenanigans entirely.
  const regexes = patterns.map((p) => new RegExp(`^${globToRegexBody(p)}$`));
  return (name) => regexes.some((r) => r.test(name));
}

function globToRegexBody(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^.]+";
      }
      continue;
    }
    if (/[.+?^${}()|[\]\\]/.test(c ?? "")) out += `\\${c}`;
    else out += c;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Endpoint path → canonical event name. BA's URL conventions are stable
// enough across plugins to map most flows without a config explosion.
// Unknown paths fall through to `resolveEndpointEvent`.
// ─────────────────────────────────────────────────────────────────────

const ENDPOINT_TO_EVENT: ReadonlyArray<{ test: RegExp; phase: "before" | "after"; name: string }> =
  [
    // MFA
    { test: /\/two-factor\/(verify|verify-totp|verify-otp)\b/, phase: "after", name: "mfa.verify" },
    { test: /\/two-factor\/(enable|enroll|setup)\b/, phase: "after", name: "mfa.enroll" },
    { test: /\/two-factor\/disable\b/, phase: "after", name: "mfa.disable" },
    // Password / verification
    {
      test: /\/forget-password\b|\/forgot-password\b/,
      phase: "after",
      name: "password.reset.request",
    },
    { test: /\/reset-password\b/, phase: "after", name: "password.reset.complete" },
    { test: /\/verify-email\b/, phase: "after", name: "email.verify" },
    // Organization
    { test: /\/organization\/create\b/, phase: "after", name: "org.create" },
    { test: /\/organization\/delete\b/, phase: "after", name: "org.delete" },
    {
      test: /\/organization\/invite\b(?!.*accept|.*reject)/,
      phase: "after",
      name: "org.invite.create",
    },
    {
      test: /\/organization\/(accept-invitation|invite\/accept)\b/,
      phase: "after",
      name: "org.invite.accept",
    },
    {
      test: /\/organization\/(reject-invitation|invite\/reject)\b/,
      phase: "after",
      name: "org.invite.reject",
    },
    { test: /\/organization\/add-member\b/, phase: "after", name: "org.member.add" },
    { test: /\/organization\/remove-member\b/, phase: "after", name: "org.member.remove" },
    {
      test: /\/organization\/update-member-role\b/,
      phase: "after",
      name: "org.member.role.update",
    },
    // API keys
    { test: /\/api-key\/create\b/, phase: "after", name: "apikey.create" },
    { test: /\/api-key\/delete\b/, phase: "after", name: "apikey.delete" },
  ];

function classifyEndpoint(
  phase: "before" | "after" | "error",
  ctx: BetterAuthHookContext,
): string | null {
  const path = ctx.path ?? "";
  for (const entry of ENDPOINT_TO_EVENT) {
    if (entry.phase === phase && entry.test.test(path)) return entry.name;
  }
  // MFA failures arrive on the `error` phase of the verify endpoint.
  if (phase === "error" && /\/two-factor\/verify/.test(path)) return "mfa.failed";
  if (phase === "error" && /\/api-key\/create\b/.test(path)) return "apikey.failed";
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Bridge factory
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_EVENTS: readonly string[] = [
  "session.create",
  "session.delete",
  "user.create",
  "user.delete",
];

export function wireBetterAuthAudit(opts: WireBetterAuthAuditOptions = {}): BetterAuthAuditBridge {
  const matches = compileGlobs(opts.events ?? DEFAULT_EVENTS);
  const bufferSize = opts.bufferSize ?? 1000;
  const transform = opts.transform;
  const resolveEndpointEvent = opts.resolveEndpointEvent ?? classifyEndpoint;

  const buffer: AuthEvent[] = [];
  let liveAudit: FastifyInstance["audit"] | null = null;
  let liveLog: FastifyInstance["log"] | null = null;
  let droppedFromBuffer = 0;
  let dispatchFailures = 0;
  let dispatchAttempts = 0;

  async function dispatch(event: AuthEvent): Promise<void> {
    dispatchAttempts++;
    if (!matches(event.name)) return;

    const finalEvent = transform ? await transform(event) : event;
    if (!finalEvent) return;

    if (!liveAudit) {
      // FIFO eviction when buffer is full — preserves the latest events,
      // drops the oldest. Counter surfaced through `getStats()` and logged
      // by `attach` so ops can detect chronic boot-time event floods.
      if (buffer.length >= bufferSize) {
        buffer.shift();
        droppedFromBuffer++;
      }
      buffer.push(finalEvent);
      return;
    }

    try {
      await liveAudit.custom("auth", finalEvent.subjectId, finalEvent.name, finalEvent.payload, {
        user: finalEvent.userId
          ? ({ id: finalEvent.userId } as Record<string, unknown>)
          : undefined,
        organizationId: finalEvent.organizationId,
      });
    } catch (err) {
      dispatchFailures++;
      liveLog?.warn?.({ err, event: finalEvent.name }, "auth audit bridge: dispatch failed");
    }
  }

  // Build a single dispatcher per phase — internally handles classification
  // for every endpoint. Used directly as BA's top-level `hooks.before/after`
  // function and (re-)wrapped in `{matcher,handler}` for `asPluginHooks()`.
  async function dispatchEndpoint(
    phase: "before" | "after" | "error",
    ctx: BetterAuthHookContext,
  ): Promise<void> {
    const name = resolveEndpointEvent(phase, ctx);
    if (!name) return;
    const session = ctx.context?.session;
    await dispatch({
      name,
      subjectId: session?.user?.id ?? "",
      userId: session?.user?.id,
      organizationId: session?.activeOrganizationId,
      payload: {
        path: ctx.path,
        method: ctx.method,
        ip: ctx.context?.request?.ip,
        ...(phase === "error" && ctx.error
          ? { error: ctx.error instanceof Error ? ctx.error.message : String(ctx.error) }
          : {}),
      },
    });
  }

  function makeEndpointHook(phase: "before" | "after" | "error"): BetterAuthHookEntry {
    return {
      matcher: () => true,
      handler: async (ctx: BetterAuthHookContext) => {
        await dispatchEndpoint(phase, ctx);
        return {};
      },
    };
  }

  const bridge: BetterAuthAuditBridge = {
    hooks: {
      before: async (ctx) => {
        await dispatchEndpoint("before", ctx);
        // BA's runBeforeHooks / runAfterHooks read `.headers` and `.response`
        // off the return value — must be a plain object, never undefined.
        return {};
      },
      after: async (ctx) => {
        await dispatchEndpoint("after", ctx);
        return {};
      },
    },
    asPluginHooks() {
      return {
        before: [makeEndpointHook("before")],
        after: [makeEndpointHook("after")],
      };
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await dispatch({
              name: "user.create",
              subjectId: user.id ?? "",
              userId: user.id,
            });
          },
        },
        update: {
          after: async (user) => {
            await dispatch({
              name: "user.update",
              subjectId: user.id ?? "",
              userId: user.id,
            });
          },
        },
        delete: {
          after: async (user) => {
            await dispatch({
              name: "user.delete",
              subjectId: user.id ?? "",
              userId: user.id,
            });
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await dispatch({
              name: "session.create",
              subjectId: session.id ?? "",
              userId: session.userId,
              organizationId: session.activeOrganizationId,
              payload: {
                ip: session.ipAddress,
                userAgent: session.userAgent,
                impersonatedBy: session.impersonatedBy,
              },
            });
          },
        },
        update: {
          after: async (session) => {
            await dispatch({
              name: "session.update",
              subjectId: session.id ?? "",
              userId: session.userId,
              organizationId: session.activeOrganizationId,
            });
          },
        },
        delete: {
          after: async (session) => {
            await dispatch({
              name: "session.delete",
              subjectId: session.id ?? "",
              userId: session.userId,
              organizationId: session.activeOrganizationId,
            });
          },
        },
      },
    },
    attach(app) {
      liveAudit = app.audit;
      liveLog = app.log;

      // Drain buffered events in order. Errors during drain are logged,
      // not thrown — boot must never fail because of audit retro-fill.
      const pending = buffer.splice(0);
      if (droppedFromBuffer > 0) {
        liveLog?.warn?.(
          { dropped: droppedFromBuffer, bufferSize },
          "auth audit bridge: pre-attach buffer overflowed; oldest events lost",
        );
      }
      if (pending.length === 0) return;
      void Promise.all(
        pending.map((event) =>
          liveAudit
            ?.custom("auth", event.subjectId, event.name, event.payload, {
              user: event.userId ? ({ id: event.userId } as Record<string, unknown>) : undefined,
              organizationId: event.organizationId,
            })
            .catch((err) => {
              dispatchFailures++;
              liveLog?.warn?.(
                { err, event: event.name },
                "auth audit bridge: buffered drain failed",
              );
            }),
        ),
      );
    },
    emit(event) {
      void dispatch(event);
    },
    getStats() {
      return {
        droppedFromBuffer,
        dispatchFailures,
        dispatchAttempts,
        pendingBuffered: buffer.length,
      };
    },
  };

  return bridge;
}
