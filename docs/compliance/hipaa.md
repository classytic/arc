# HIPAA — Technical Safeguards Mapping

How each HIPAA Security Rule §164.308–§164.312 requirement maps to an arc primitive.

> **What this is:** an engineering reference for Covered Entities and Business Associates building PHI-handling systems. Arc gives you the controls; your BAA, Risk Assessment, and Sanction Policy are out of scope (process artifacts).

## §164.308 — Administrative Safeguards

| § | Requirement | Arc primitive |
|---|---|---|
| 308(a)(1)(ii)(D) | Information system activity review | `auditPlugin.query({ from, to, ... })` — pull period activity for review. `wireBetterAuthAudit` adds auth events to the same store |
| 308(a)(3)(ii)(B) | Workforce clearance procedure | SCIM provisioning (`@classytic/arc/scim`) — IdP-driven, deprovisions on termination ≤5 min |
| 308(a)(3)(ii)(C) | Termination procedure | SCIM `DELETE /Users/:id` triggered by HR system → cascading session revoke via `isRevoked` |
| 308(a)(4)(ii)(A) | Isolation of healthcare clearinghouse | `multiTenantPreset({ tenantField: 'organizationId' })` — strict per-org row filtering on read AND write |
| 308(a)(4)(ii)(C) | Access establishment & modification | `requireRoles(['provider', 'admin'])`, `createDynamicPermissionMatrix(...)` for DB-driven role changes |
| 308(a)(5)(ii)(C) | Log-in monitoring | `wireBetterAuthAudit({ events: ['session.*', 'mfa.failed'] })` |
| 308(a)(6)(ii) | Response and reporting | Subscribe to `arc.scope.elevated` + audit query for incident timeline reconstruction |
| 308(a)(7)(ii)(D) | Testing and revision | Out of arc (DR test process); `EventOutbox` ensures events survive worker crash for replay |

## §164.310 — Physical Safeguards

Out of arc scope (facility / device controls). Arc stays operational regardless.

## §164.312 — Technical Safeguards

| § | Requirement | Arc primitive |
|---|---|---|
| 312(a)(1) | Unique user identification | `request.scope.userId` + `request.scope.clientId` (machines distinct) — required by `requireUserId(scope)` / `requireClientId(scope)` |
| 312(a)(2)(i) | Emergency access procedure | Elevation via `arc.scope.elevated` — explicit, audited, optionally restricted via `noElevatedBypass: true` on regulated mandates |
| 312(a)(2)(iii) | Automatic logoff | Better Auth `secondaryStorage` + session TTL config (BA owns the timer) |
| 312(a)(2)(iv) | Encryption and decryption | App-level (TLS via fastify, at-rest via DB driver) — arc carries no plaintext PHI through its own pipes |
| 312(b) | Audit controls — record and examine | `auditPlugin` (resource events) + `wireBetterAuthAudit` (auth events) — single canonical store, queryable by user/resource/period |
| 312(c)(1) | Integrity — alteration/destruction protection | `idempotencyPlugin` (body-hash fingerprint blocks replay with mismatch) + `audit` records `before` / `after` on every update |
| 312(c)(2) | Mechanism to authenticate ePHI | `auditPlugin` records `changes: ['field1', 'field2']` per update — anomalous diffs visible immediately |
| 312(d) | Person or entity authentication | `auth: { type: 'jwt' \| 'betterAuth' \| 'authenticator' }` — every request passes through the authenticator before hitting handlers |
| 312(e)(1) | Transmission security | `helmet: true` (HSTS, CSP, Frame-Options); `tls: { ... }` at the Fastify level |
| 312(e)(2)(i) | Integrity controls (transmission) | `verifySignature(req.rawBody, ...)` for inbound webhooks; HMAC-signed events via `EventOutbox` |
| 312(e)(2)(ii) | Encryption (transmission) | TLS 1.2+ at the listener; `auth.api.*` is in-process (no HTTP round-trip leak) |

## §164.502(a) — Minimum Necessary

| Requirement | Arc primitive |
|---|---|
| Limit PHI use/disclosure to minimum necessary | `fields.hidden()` (never sent), `fields.visibleTo(['admin'])` (role-gated), `fields.redactFor(['viewer'], '***')` (masked); per-route `select` (server-side projection) |
| For AI agents | `requireMandate('phi.read', { cap: rowLimit, audience: 'patient:'+id })` — per-request narrowed authorization |

## §164.504(e) — Business Associate Contracts

Process control. Arc audit chain provides the evidence trail BAA addenda typically require ("BA shall maintain logs of all access to PHI for 6 years").

## Audit retention

```typescript
auditPlugin({
  enabled: true,
  repository: auditRepo,
  retention: {
    maxAgeMs: 6 * 365 * 24 * 60 * 60 * 1000,    // HIPAA 6-year minimum
    purgeIntervalMs: 24 * 60 * 60 * 1000,
  },
});
```

For Mongo: declare a TTL index on `timestamp` instead — server-side TTL is cheaper than periodic delete.

## Breach notification readiness

`audit.query()` + `request.scope.organizationId` + `auditEntry.ipAddress` give you the evidence shape `45 CFR 164.404(c)` requires:

- Identification of unauthorized access (timestamp, user, action, resource, document id)
- Scope of breach (filter by `documentId`)
- Steps taken (subsequent audit rows showing remediation)

## What's NOT in arc

- **BAA** template / management — legal artifact
- **Risk Analysis** worksheet — process artifact
- **Security Awareness Training** records — HR system
- **Sanction Policy** — process control
- **Encryption at rest** — DB / disk concern (Mongo Encrypted Storage Engine, FileVault, etc.)

## See also

- [soc2.md](soc2.md) — SOC 2 Trust Services Criteria
- [enterprise-auth.md](../../skills/arc/references/enterprise-auth.md) — feature matrix
- [`audit-trail`](../../skills/arc/references/production.md) — audit-plugin operational guide
