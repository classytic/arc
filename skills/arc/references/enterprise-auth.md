# Enterprise Auth — what's in the box

Arc 2.13 closes the enterprise-auth gaps without forcing a parallel infrastructure. Sessions / refresh / OAuth flows stay in Better Auth's hands; arc adds the three things arc actually owns: provisioning, agent-mandate gating, and audit chain.

## In-box (2.13)

| Capability | Surface | Notes |
|---|---|---|
| **SCIM 2.0 provisioning** | `@classytic/arc/scim` | Auto-derived `/scim/v2/Users` + `/scim/v2/Groups` from existing resources. Filter, PATCH, discovery endpoints. Bearer or `verify` callback. → [scim.md](scim.md) |
| **Agent capability mandates** | `requireAgentScope`, `requireMandate`, `requireDPoP` from `@classytic/arc/permissions` | AP2 / Stripe x402 / MCP authorization. `RequestScope.service.mandate` + `.dpopJkt` are first-class. → [agent-auth.md](agent-auth.md) |
| **Auth-event audit chain** | `wireBetterAuthAudit` from `@classytic/arc/auth/audit` | BA's `databaseHooks` + endpoint hooks routed through existing `auditPlugin`. One canonical row shape for resource AND auth events. |
| **Sessions / refresh / OAuth / MFA / SSO providers** | Better Auth | Configure via BA's `secondaryStorage`, `plugins: [twoFactor(), bearer(), apiKey(), ...]`. Arc reads BA tables via the kit overlays. → [auth.md](auth.md) |
| **Multi-role / multi-tenant / parent-child orgs** | `RequestScope` + presets | Pre-2.13. → [multi-tenancy.md](multi-tenancy.md) |
| **Field-level redaction + dynamic ACL + role hierarchy** | `@classytic/arc/permissions` | Pre-2.13. |
| **Resource-op audit + retention + per-resource opt-in** | `@classytic/arc/audit` | Pre-2.13. |
| **API-key admin REST** | BA `apiKey()` plugin + arc overlay | Recipe in [auth.md](auth.md). |

## Out-of-box (deliberate)

| Capability | Why arc doesn't ship it | What to use instead |
|---|---|---|
| **First-party SAML** | BA SAML plugin is the canonical path; arc can't compete with IdP edge cases | Better Auth SAML plugin (community, maturing) or `@node-saml/passport-saml` wrapped in arc's `authenticate` callback |
| **Session storage / Redis sessions** | BA's `secondaryStorage` covers this — duplicating fragments truth | Configure BA's `secondaryStorage: { get, set, delete }` with `ioredis` directly |
| **Refresh-token rotation** | BA owns the session model; arc would have to parallel-implement to add it | BA handles rotation in its session model; for JWT auth, use the existing `isRevoked` hook |
| **DPoP cryptographic proof verification** | One `jose.dpop.verify()` call in your authenticate function — arc would force peer-dep `jose` | `jose` (already a peer of most apps using OAuth/JWT) |
| **Mandate JWT/VC parsing** | Format varies per IdP/issuer; arc validates *what's verified*, not how it's verified | `jose` for JWTs, `did-jwt-vc` for Verifiable Credentials |
| **Device trust / risk scoring** | Out of framework scope; vendor-specific | Castle, Stytch, Auth0 Risk, Persona |
| **SOC2/HIPAA attestations** | Arc gives you the controls; certification is per-deployment | [`docs/compliance/soc2.md`](../../../docs/compliance/soc2.md) maps controls to arc primitives |
| **First-party SSO discovery** (`/.well-known/openid-configuration` aggregation) | No real demand; BA exposes its own well-known paths | BA's `openAPI()` + `mcp()` plugins emit RFC 9728 metadata |

## Sequencing — how the three new pieces compose

```
        IdP (Okta / Azure AD)
              │
              │  SCIM provisioning  ──→  /scim/v2/Users  ──→  arc user resource
              │
              │  SAML / OIDC SSO    ──→  Better Auth      ──→  scope.kind = 'member'
              │                                                       │
              ▼                                                       │
        end-user signs in                                             │
              │                                                       │
              │  → BA databaseHooks.session.create.after              │
              │  → wireBetterAuthAudit dispatches                     │
              │  → audit row: { resource:'auth', action:'session.create' }
              ▼
        end-user delegates to AI agent
              │
              │  user authorizes mandate (cap, audience, ttl)
              │  IdP / your token endpoint mints mandate JWT
              ▼
        AI agent calls protected route
              │
              │  Authorization: Mandate <jwt>
              │  DPoP: <proof>
              │
              ▼
        arc authenticate fn:
          - jose.jwtVerify(mandate, JWKS)
          - jose.dpop.verify(proof)
          - sets scope = { kind:'service', mandate, dpopJkt, ... }
              │
              ▼
        requireAgentScope({ capability, audience, validateAmount, requireDPoP })
              │
              ├─ ✓ auditPlugin.custom('invoice','INV-7','pay', { mandate.id, dpopJkt })
              │   ↳ same store as session.create row above
              │
              └─ executes handler
```

## Threat model — what each layer prevents

| Threat | Mitigation |
|---|---|
| Stale offboarded user keeps access | SCIM `DELETE /Users/:id` → resource soft-delete on connector trigger |
| Stolen bearer token replay | `requireDPoP()` — token is bound to agent's keypair |
| Agent overspends user authorization | `requireMandate({ validateAmount, cap })` — per-call ceiling |
| Agent uses payment mandate against wrong invoice | `requireMandate({ audience: ctx => 'invoice:'+ctx.params.id })` |
| Mandate replay after revocation | `expiresAt` (short TTL) + your IdP's revocation endpoint |
| Untraceable agent action | Audit bridge stamps `mandate.id`, `dpopJkt`, `clientId` on every row |
| Org admin abuses elevated scope | `noElevatedBypass: true` on regulated mandates; `arc.scope.elevated` audit event |
| Failed sign-in / MFA flooding | `wireBetterAuthAudit` captures `mfa.failed` events; rate-limit on `clientId` |

## Compliance

See [`docs/compliance/soc2.md`](../../../docs/compliance/soc2.md) and [`docs/compliance/hipaa.md`](../../../docs/compliance/hipaa.md) for the control matrix mapping each requirement (CC6.1 access provisioning, CC7.2 logging, §164.308 admin safeguards) to the specific arc primitive that satisfies it.

## See also

- [scim.md](scim.md) — provisioning surface deep-dive
- [agent-auth.md](agent-auth.md) — DPoP + mandate semantics
- [auth.md](auth.md) — Better Auth + multi-plugin matrix
- [`playground/enterprise-auth/`](../../../playground/enterprise-auth/) — full runnable smoke
