# Enterprise auth map

What arc owns for enterprise auth, what it delegates, and the auth-event audit bridge. Sessions, refresh and OAuth/MFA/SSO stay in Better Auth.

## In the box

| Need | Surface | File |
|---|---|---|
| IdP provisioning (Okta, Azure AD) | `scimPlugin` from `@classytic/arc/scim` | scim.md |
| Agent mandates, DPoP | `requireAgentScope`, `requireMandate`, `requireDPoP` from `@classytic/arc/permissions` | agent-auth.md |
| Auth-event audit | `wireBetterAuthAudit` from `@classytic/arc/auth/audit` | below |
| Sessions, OAuth, MFA, SSO | Better Auth plugins | auth-better-auth.md |
| Multi-role, multi-tenant, parent-child orgs | `RequestScope`, presets | multi-tenancy.md |
| Field redaction, dynamic ACL, role hierarchy | `@classytic/arc/permissions` | auth-permissions.md |
| Resource-op audit and retention | `@classytic/arc/audit` | production-audit.md |
| API-key admin | BA `apiKey()` plus overlay | auth-api-keys.md |

## Auth-event audit bridge

Routes BA lifecycle events through arc's `auditPlugin`: `resource: 'auth'`, `action` = event name, `documentId` = subject id. One store for resource and auth events.

```typescript
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins/organization';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { createBetterAuthAdapter } from '@classytic/arc/auth';
import { wireBetterAuthAudit } from '@classytic/arc/auth/audit';

const audit = wireBetterAuthAudit({ events: ['session.*', 'user.create', 'mfa.*', 'org.invite.*'] });

const auth = betterAuth({
  plugins: [organization(), twoFactor()],
  hooks: audit.hooks,                   // endpoint hooks: MFA, OAuth, password reset
  databaseHooks: audit.databaseHooks,   // session/user create, update, delete
});

const app = await createApp({
  auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth }) },
  arcPlugins: { audit: { repository: auditRepo } },
});
audit.attach(app);                       // flush buffered boot events, connect live logger
```

| Option | Purpose |
|---|---|
| `events` | Glob patterns (`*` one segment, `**` deep). Default `['session.*', 'user.create', 'user.delete']` |
| `transform(event)` | Redact or rename; return `null` to drop |
| `resolveEndpointEvent(phase, ctx)` | Name unclassified endpoint hits; `null` drops |
| `bufferSize` | Pre-`attach` buffer (default 1000, FIFO drop) |

Event names: `session.create|delete|update`, `user.create|update|delete`, `mfa.enroll|verify|failed|disable`, `password.reset.request|complete`, `email.verify`, `org.create|delete`, `org.invite.create|accept|reject`, `org.member.add|remove|role.update`, `apikey.create|delete|failed`, plus `endpoint.before|after|error` for unclassified endpoints.

For a plugin author, `audit.asPluginHooks()` returns array-form hooks for `plugins: [{ id, hooks }]`.

## Not in arc

| Capability | Use instead |
|---|---|
| First-party SAML | BA SAML plugin, or `@node-saml/passport-saml` inside `authenticate` |
| Redis sessions, refresh rotation | BA `secondaryStorage` and session model; JWT auth uses `isRevoked` |
| DPoP proof or mandate JWT/VC verification | `jose`, `did-jwt-vc` in `authenticate` |
| Device trust, risk scoring | Vendor (Castle, Stytch, Auth0 Risk) |
| Compliance attestations | `docs/compliance/soc2.md`, `docs/compliance/hipaa.md` map controls to arc primitives |

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Offboarded user keeps access | SCIM `DELETE /Users/:id` |
| Stolen bearer replay | `requireDPoP()` |
| Agent overspends | `requireMandate({ validateAmount })` |
| Mandate used on wrong resource | `requireMandate({ audience })` |
| Replay after revocation | Short `expiresAt` plus IdP revocation |
| Untraceable agent action | `audit.custom` with mandate id and `dpopJkt` |
| Elevated admin abuse | `noElevatedBypass: true` on regulated mandates; elevation `onElevation` hook |
| MFA or sign-in flooding | `mfa.failed` audit events; rate limit per client |

Runnable smoke: `playground/enterprise-auth/`.
