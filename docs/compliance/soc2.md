# SOC 2 — Control Matrix

How each Trust Services Criteria (TSC) requirement maps to an arc primitive.

> **What this is:** an engineering reference, not a legal opinion. Pair with your auditor's interpretation. SOC 2 certification is per-deployment — arc gives you the controls; your evidence chain (logs, configurations, change records) demonstrates them.

## CC6 — Logical & physical access controls

| TSC | Requirement | Arc primitive |
|---|---|---|
| CC6.1 | Logical access provisioning, modification, removal | **SCIM 2.0 plugin** (`@classytic/arc/scim`) — `POST /scim/v2/Users` (provisioning), `PATCH` (modification), `DELETE` (deprovisioning). IdP-driven; Okta / Azure AD / Google Workspace integrate out of the box. |
| CC6.1 | Authenticated identity for every access | `auth: { type: ... }` — JWT, Better Auth, custom authenticator, or `false` for explicitly public services |
| CC6.1 | Role-based access | `requireRoles(['admin'])`, `requireOrgRole('owner')`, `createDynamicPermissionMatrix(...)` for DB-managed ACL |
| CC6.1 | Sensitive field redaction | `fields.hidden()`, `fields.visibleTo(['admin'])`, `fields.redactFor(['viewer'], '***')` |
| CC6.2 | Timely deprovisioning | SCIM `DELETE /Users/:id` triggered by IdP on termination — typically ≤5 minutes from HR change |
| CC6.2 | Inventory of authorized personnel | `userResource` is the inventory; `arc introspect` lists every role + scope |
| CC6.3 | Least-privilege role assignment | `requireServiceScope('jobs:write')` (OAuth-style scopes for service identities), `fields.writableBy(['admin'])` |
| CC6.6 | Restricted privileged access | `arc.scope.elevated` event fires on every elevation; subscribe + audit. `noElevatedBypass: true` on `requireMandate` for regulated flows |
| CC6.7 | Restricted transmission of confidential data | `helmet: true` (default in `production` preset), per-route response sanitizers via `fields.hidden()` |
| CC6.8 | Detection of unauthorized changes | `auditPlugin` records every CRUD; combined with `wireBetterAuthAudit` for auth events. `audit: { operations: ['delete'] }` for high-stakes-only |

## CC7 — System operations

| TSC | Requirement | Arc primitive |
|---|---|---|
| CC7.1 | Detection of new vulnerabilities | Out of arc (use Snyk / Dependabot / npm audit on the host); arc itself runs `knip` + Biome + targeted tests on every release |
| CC7.2 | System monitoring + event logging | `auditPlugin` (resource + auth events, single store); `tracingPlugin` (OTel spans); `metricsPlugin` (Prometheus) |
| CC7.2 | Logged events include user, action, timestamp, source IP | `AuditEntry` shape: `userId`, `action`, `timestamp`, `ipAddress`, `userAgent`, `requestId`, `endpoint` |
| CC7.2 | Auth events captured | `wireBetterAuthAudit({ events: ['session.*', 'user.*', 'mfa.*', 'org.invite.*'] })` |
| CC7.2 | Tamper-resistant audit storage | Pass an append-only `customStores: [kafkaStore]` or use a Mongo TTL index + write-only credential |
| CC7.3 | Incident response — anomaly detection | Subscribe to `arc.scope.elevated` (emitted by elevation plugin) and BA-bridged `mfa.failed` events via `wireBetterAuthAudit` |
| CC7.4 | Recovery of unauthorized changes | Soft-delete preset (`presets: ['softDelete']`) + `audit` records full before/after on every update |

## CC8 — Change management

| TSC | Requirement | Arc primitive |
|---|---|---|
| CC8.1 | Authorized changes only | `audit` records who/when on every CRUD; combine with `requireRoles(['release-engineer'])` on deploy-related resources |
| CC8.1 | Pre-change risk assessment | Out of arc — process control |

## A1 — Availability (when in scope)

| TSC | Requirement | Arc primitive |
|---|---|---|
| A1.1 | Capacity monitoring | `metricsPlugin` (Prometheus), `healthPlugin` (`/healthz`, `/readyz`), `gracefulShutdownPlugin` |
| A1.2 | Backup and recovery | App-level concern; arc events flow through `EventOutbox` (transactional outbox) for guaranteed delivery on retry |

## C1 — Confidentiality (when in scope)

| TSC | Requirement | Arc primitive |
|---|---|---|
| C1.1 | Identification of confidential information | `fields.hidden()` marks per-field; `idempotencyPlugin` rejects body-hash mismatches |
| C1.2 | Protection during processing | `multiTenantPreset` auto-injects tenant filter on read AND write; `requireOrgInScope` for hierarchy |

## P1–P8 — Privacy (when in scope)

| TSC | Requirement | Arc primitive |
|---|---|---|
| P4 | Use limitation | `requireMandate('data.export', { cap, audience })` for AI agent data flows — per-request scope |
| P6 | Disclosure to third parties | Audit row mandate fields (`mandate.id`, `audience`) record exactly what was authorized |
| P7 | Quality / accuracy | `fieldRules: { ...constraints }` enforce server-side validation before write |

## Evidence chain

For the audit, your auditor will ask for evidence that controls operate. Arc surfaces:

- **Audit query**: `await app.audit.query({ from, to, action: 'session.create' })` — every sign-in in the period
- **Permission introspection**: `arc introspect` lists every resource's `permissions` map + `audit: true` opt-ins
- **OpenAPI spec**: `arc docs ./openapi.json` — full surface, security schemes, role requirements
- **Test coverage**: `npm run test:ci` — every permission combinator has unit tests

## What's NOT in arc

- **Vendor risk assessment** (vendors you import) — process control
- **Background check** records — HR system
- **Physical access** logs — facility system
- **DR test** records — process artifacts (arc just stays running through them)

## See also

- [hipaa.md](hipaa.md) — HIPAA Technical Safeguards
- [enterprise-auth.md](../../skills/arc/references/enterprise-auth.md) — feature matrix
- [auth.md](../../skills/arc/references/auth.md) — auth surface deep-dive
