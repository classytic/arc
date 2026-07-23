# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security reports.** Use GitHub's private
vulnerability reporting on this repository ("Report a vulnerability" under
the Security tab). If that is unavailable to you, email
`developer@sensenrespond.com` with `[arc security]` in the subject.

You can expect an acknowledgement within 72 hours and a triage verdict
(affected versions, severity, planned fix window) within 7 days.

## Supported versions

Security fixes target the **latest published minor** of `@classytic/arc`.
Older minors receive backports only when a known production consumer
cannot upgrade trivially.

## Scope notes for reporters

Security-relevant subsystems with documented threat models (useful context
for a report):

- Auth/scope resolution (`src/auth`, `src/scope`) — tenant selection is
  duplicate-header-rejecting; `isRevoked` is fail-closed.
- Webhooks (`src/integrations/webhooks.ts`) — v1 HMAC contract
  (timestamp + delivery-id bound), SSRF URL policy seam, redirect
  handling.
- Field-level permissions (HTTP + MCP surfaces are contractually
  identical — a masking divergence between them is a vulnerability).
- Rate limiting / `trustProxy` — production preset is fail-closed
  (`trustProxy: false` by default).
- Query surface — populate/lookup are deny-by-default; filter parsing is
  depth- and parameter-bounded.

Hardening reports (missing headers, dependency advisories with no
reachable path) are welcome as ordinary issues.
