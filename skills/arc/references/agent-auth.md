# Agent Auth — DPoP + Capability Mandates

The 2025 stack for AI-agent-led actions on protected resources: **OAuth 2.1** (RFC 9700), **DPoP** (RFC 9449), **OAuth Protected Resource Metadata** (RFC 9728), **AP2** (Google + Anthropic + Stripe Agent Payments Protocol), **Stripe x402 / Agentic Commerce**, **MCP authorization**.

Arc 2.13 adds three permission helpers and two scope fields to model these patterns cleanly. **Arc doesn't parse JWTs or verify DPoP proofs** — that's a 1-2 line `jose` call in your authenticate function. Arc validates *what's already proved* against the action being attempted.

## The two new scope fields

`RequestScope.service` gains two optional fields (additive, no breaking change):

```typescript
{
  kind: 'service',
  clientId,
  organizationId,
  scopes,
  // ── new in 2.13 ──
  mandate?: Mandate,        // capability mandate (AP2 / x402 / MCP)
  dpopJkt?: string,         // DPoP key thumbprint (RFC 7638)
  // existing fields preserved
}
```

The `Mandate` type:

```typescript
interface Mandate {
  id: string;                    // jti
  capability: string;            // 'payment.charge' / 'data.export' / 'inbox.send'
  cap?: number;                  // numeric ceiling
  currency?: string;             // ISO 4217 when monetary
  expiresAt?: number;            // epoch ms
  parent?: string;               // delegation chain
  audience?: string;             // 'invoice:INV-7' — resource binding
  meta?: Record<string, unknown>; // verifier-supplied extras
}
```

Read with `getMandate(scope)` / `getDPoPJkt(scope)` from `@classytic/arc/scope`.

## Permission helpers

Three new combinators in `@classytic/arc/permissions`:

### `requireDPoP()` — sender-constrained credentials

The inbound credential must be DPoP-bound. Arc reads `scope.dpopJkt`; your authenticate function performs `jose.dpop.verify()` and sets the field.

```typescript
import { requireDPoP } from "@classytic/arc/permissions";

permissions: {
  charge: allOf(requireServiceScope("payment.write"), requireDPoP()),
}
```

Pass behavior: service scope with `dpopJkt` set → grant. Elevated → grant. Anything else → deny.

### `requireMandate(capability, opts?)` — capability-scoped authorization

The presented mandate must:
1. Authorize the requested `capability`
2. Not be expired (with optional grace window)
3. Be bound to the right resource (when `audience` opt is set)
4. Pass `validateAmount(ctx, mandate)` (when set)

```typescript
import { requireMandate } from "@classytic/arc/permissions";

permissions: {
  pay: requireMandate("payment.charge", {
    audience: (ctx) => `invoice:${ctx.params?.id}`,
    validateAmount: (ctx, mandate) => {
      const amount = (ctx.data as { amount?: number })?.amount ?? 0;
      if (amount <= (mandate.cap ?? 0)) return true;
      return `Amount ${amount} exceeds mandate cap ${mandate.cap}`;
    },
    ttlGraceMs: 30_000,           // default: 30s clock skew
    noElevatedBypass: false,       // platform admins normally bypass; set true for break-glass audit flows
  }),
}
```

### `requireAgentScope(opts)` — composite gate

Bundles the three things every high-value agent endpoint needs (service identity + capability mandate + DPoP binding) into one call:

```typescript
import { requireAgentScope } from "@classytic/arc/permissions";

defineResource({
  name: "invoice",
  actions: {
    pay: {
      handler: payInvoice,
      permissions: requireAgentScope({
        capability: "payment.charge",
        scopes: ["payment.write"],          // OAuth `scopes` the client must hold
        requireDPoP: true,                  // default true
        audience: (ctx) => `invoice:${ctx.params?.id}`,
        validateAmount: (ctx, m) => (ctx.data as { amount: number }).amount <= (m.cap ?? 0),
      }),
    },
  },
});
```

Use this instead of hand-composing `allOf(requireServiceScope(...), requireMandate(...), requireDPoP())` — fewer ways to misconfigure, one metadata tag downstream tools (audit, MCP, OpenAPI) can read.

## Wiring — the authenticate callback

Arc takes no position on which credential format you use. Whatever your verifier produces — JWT, JWT-VC mandate, opaque API key with metadata sidecar — populates `RequestScope.service`:

```typescript
import { jwtVerify, createRemoteJWKSet } from "jose";

const JWKS = createRemoteJWKSet(new URL("https://idp.example.com/.well-known/jwks.json"));

await createApp({
  auth: {
    type: "authenticator",
    authenticate: async (request) => {
      const auth = request.headers.authorization?.split(" ");
      if (auth?.[0] !== "Mandate") return null;

      // 1. Verify the mandate JWT (signature, iss, aud, exp)
      const { payload } = await jwtVerify(auth[1], JWKS, {
        issuer: "https://idp.example.com",
        audience: "https://api.example.com",
      });

      // 2. Verify the DPoP proof header (RFC 9449)
      //    — pseudocode; use jose.dpop.verify() in production
      const dpopJkt = await verifyDPoPProof(request, payload.cnf?.jkt);
      if (!dpopJkt) return null;

      // 3. Populate scope with mandate + DPoP fingerprint
      request.scope = {
        kind: "service",
        clientId: payload.iss as string,
        organizationId: (payload.org as string) ?? "",
        scopes: ((payload.scope as string) ?? "").split(" ").filter(Boolean),
        mandate: {
          id: payload.jti as string,
          capability: payload.cap as string,
          cap: payload.amount as number | undefined,
          currency: payload.currency as string | undefined,
          expiresAt: (payload.exp as number) * 1000,
          audience: payload.aud as string | undefined,
          parent: payload.parent as string | undefined,
        },
        dpopJkt,
      };

      return { id: payload.iss as string };
    },
  },
});
```

## Mandate flow — typical AP2 / x402 sequence

```
                   ┌──────────────┐
   user grants     │              │
   "charge up to   │   Customer   │
    $50 on inv 7"  │              │
                   └──────┬───────┘
                          │
                ┌─────────▼──────────┐
                │  Issues mandate    │
                │  - cap: 50 USD     │
                │  - audience:       │
                │    "invoice:INV-7" │
                │  - exp: now + 60s  │
                │  - cnf.jkt: agent  │
                └─────────┬──────────┘
                          │
                          ▼
              ┌──────────────────────┐
              │     AI Agent         │
              │  signs + presents    │
              │  mandate via DPoP    │
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  Arc app             │
              │  authenticate fn:    │
              │  - verify mandate    │
              │  - verify DPoP       │
              │  - set scope.mandate │
              │    + scope.dpopJkt   │
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  requireAgentScope:  │
              │  - cap satisfied?    │
              │  - audience match?   │
              │  - DPoP bound?       │
              │  - not expired?      │
              └──────────┬───────────┘
                         │
                  ✓ allow / ✗ deny
```

## Audit — every gated action gets a row

Pair with `@classytic/arc/auth/audit` to record every agent action through the canonical `auditPlugin` store. Mandate id, audience, cap, dpopJkt all flow into `metadata` on the audit row — full forensic chain.

```typescript
auditPlugin({
  actor: (request) =>
    request.scope?.kind === "service"
      ? {
          kind: "service",
          clientId: getClientId(request.scope),
          mandateId: getMandate(request.scope)?.id,
          dpopJkt: getDPoPJkt(request.scope),
        }
      : { kind: "user", userId: getUserId(request.scope) },
});
```

## What's NOT in arc (deliberate)

- **DPoP proof verification** — one `jose.dpop.verify()` call in your authenticate function. Arc would have to peer-dep `jose`; the host already has it.
- **JWT-VC mandate parser** — host's verifier (your IdP / AP2 issuer / custom).
- **Mandate issuance** — that's the IdP's job (or your token endpoint when you mint per-action mandates).
- **Risk scoring / device trust** — out of framework scope. Layer Castle / Stytch / Auth0 Risk separately.

## See also

- [enterprise-auth.md](enterprise-auth.md) — full enterprise-auth surface
- [scim.md](scim.md) — IdP provisioning (the user-creation path agents authenticate against)
- [auth.md](auth.md) — Better Auth + service identity setup
- [`playground/enterprise-auth/`](../../../playground/enterprise-auth/) — runnable smoke
