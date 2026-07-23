## What invariant changed

<!-- The behavior/contract this PR changes or adds — not a file list. -->

## API surface classification

- [ ] Additive (new exports/options; `api-surface.json` updated if it grew)
- [ ] Compatible widening (accepts more, returns the same)
- [ ] Deprecation (old path still works; window noted in changelog)
- [ ] **Breaking** (⚠ changelog entry + migration note + intentional `api-surface.json` update)
- [ ] No public surface change

## Reliability checklist (delete if not applicable)

Touches events / jobs / schedules / migrations / cache / idempotency / webhooks:

- [ ] Crash mid-operation: documented or safe (at-least-once ⇒ handler idempotent)
- [ ] Concurrent replicas: no double execution past the declared guarantees
- [ ] `wiki/delivery-guarantees.md` still truthful

## Tests

<!-- Which suites pin the new behavior; which gates you ran. -->
