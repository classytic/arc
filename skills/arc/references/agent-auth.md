# Agent auth: DPoP and capability mandates

Gate AI-agent and machine actions on a verified mandate and sender-bound credential (AP2, x402, MCP authorization, RFC 9449, RFC 9728). Arc does NOT parse JWTs or verify DPoP proofs: your `authenticate` verifies, populates scope, and arc checks the verified claims against the action.

## Scope fields (service kind)

```typescript
{
  kind: 'service', clientId, organizationId, scopes,
  mandate?: Mandate,     // capability mandate
  dpopJkt?: string,      // DPoP key thumbprint (RFC 7638)
}

interface Mandate {
  id: string;                      // jti
  capability: string;              // 'payment.charge', 'data.export', 'inbox.send'
  cap?: number;                    // numeric ceiling (meaning per capability)
  currency?: string;               // ISO 4217 when monetary
  expiresAt?: number;              // epoch ms
  parent?: string;                 // delegation chain
  audience?: string;               // resource binding, e.g. 'invoice:INV-7'
  meta?: Record<string, unknown>;  // verifier extras
}
```

Read with `getMandate(scope)`, `getDPoPJkt(scope)` from `@classytic/arc/scope`.

## Permission helpers (`@classytic/arc/permissions`)

| Helper | Passes when |
|---|---|
| `requireDPoP()` | Service scope with `dpopJkt`, or elevated |
| `requireMandate(capability, opts?)` | Mandate capability matches, not expired, audience bound, `validateAmount` ok |
| `requireAgentScope(opts)` | Service identity + OAuth scope + mandate + DPoP, in one call |

`requireMandate` options:

| Option | Meaning |
|---|---|
| `audience` | String or `(ctx) => string`; mandate must carry the same `audience` (a missing audience is denied) |
| `validateAmount(ctx, mandate)` | Return `true` or a denial string |
| `ttlGraceMs` | Clock-skew grace after `expiresAt` (default 30000) |
| `noElevatedBypass` | `true` makes elevated admins present a mandate too (break-glass flows) |

`requireAgentScope` takes the `requireMandate` options plus `capability` (required), `scopes` (the service must hold ANY listed), `requireDPoP` (default true). Prefer it over hand-composing `allOf(requireServiceScope, requireMandate, requireDPoP)`: fewer misconfigurations and one tag for MCP/OpenAPI/audit tooling.

```typescript
import { requireAgentScope } from '@classytic/arc/permissions';

defineResource({
  name: 'invoice',
  actions: {
    pay: {
      handler: payInvoice,
      permissions: requireAgentScope({
        capability: 'payment.charge',
        scopes: ['payment.write'],
        audience: (ctx) => `invoice:${ctx.params?.id}`,
        validateAmount: (ctx, m) => {
          const amount = (ctx.data as { amount?: number })?.amount ?? 0;
          return amount <= (m.cap ?? 0) || `Amount ${amount} exceeds mandate cap ${m.cap}`;
        },
      }),
    },
  },
});
```

## Wiring `authenticate`

```typescript
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://idp.example.com/.well-known/jwks.json'));

auth: {
  type: 'authenticator',
  authenticate: async (request, reply) => {
    const [scheme, credential] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Mandate' || !credential) return reply.code(401).send({ code: 'arc.unauthorized', message: 'Unauthorized', status: 401 });

    const { payload } = await jwtVerify(credential, JWKS, {
      issuer: 'https://idp.example.com',
      audience: 'https://api.example.com',
    });
    const dpopJkt = await verifyDPoPProof(request, payload.cnf?.jkt);   // your DPoP verifier
    if (!dpopJkt) return reply.code(401).send({ code: 'arc.unauthorized', message: 'DPoP proof invalid', status: 401 });

    request.scope = {
      kind: 'service',
      clientId: String(payload.iss),
      organizationId: String(payload.org ?? ''),
      scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
      mandate: {
        id: String(payload.jti),
        capability: String(payload.cap),
        cap: payload.amount as number | undefined,
        currency: payload.currency as string | undefined,
        expiresAt: (payload.exp as number) * 1000,
        audience: payload.aud as string | undefined,
        parent: payload.parent as string | undefined,
      },
      dpopJkt,
    };
    request.user = { id: String(payload.iss) };
  },
}
```

Arc takes no position on credential format (JWT, JWT-VC, opaque key plus sidecar). Anything that fills `scope.mandate` and `scope.dpopJkt` works.

Flow: user grants a limited mandate (cap, audience, short TTL, key binding) => IdP mints it => agent presents it with a DPoP proof => `authenticate` verifies and fills scope => `requireAgentScope` checks cap, audience, expiry, binding.

## Audit

Audit rows take the actor from the validated scope (`userId`, else `clientId`). Record mandate details explicitly through the audit logger:

```typescript
await app.audit.custom('invoice', id, 'pay', {
  mandateId: getMandate(request.scope)?.id,
  dpopJkt: getDPoPJkt(request.scope),
});
```

## Not in arc

DPoP proof verification, mandate JWT/VC parsing, mandate issuance, risk scoring and device trust. These belong to your verifier, IdP or a vendor.
