# Commands

**Summary**: Typecheck, lint, test, build, release commands for arc.
**Sources**: package.json, CLAUDE.md.
**Last updated**: 2026-04-21.

---

## Dev loop

```bash
npx tsc --noEmit                                     # Typecheck (strict)
npx biome check src/ --diagnostic-level=error        # Lint (Biome only)
npx vitest run tests/<path>/<file>.test.ts           # Targeted test — ALWAYS prefer this
npm run test:main                                    # Main suite (excludes perf)
npm run test:perf                                    # Isolated perf/leak suite (--expose-gc)
npm run test:ci                                      # Main + perf — CI/release only
```

**Never run the full suite during dev.** Use test mapping in [[testing]]. Perf tests run separately because GC noise from shared heap creates false failures.

## Build & publish

```bash
npm run build      # tsdown → dist/ (.mjs + .d.mts)
npm run smoke      # node scripts/smoke-test.mjs — verifies CLI + imports
npx knip           # dead code detection
```

Pre-publish checklist: typecheck → biome → `test:ci` → knip → build → smoke.

## Version injection

`__ARC_VERSION__` is replaced at build time via `tsdown.config.ts` `define`. Never hardcode a version string.

## Biome quick

```bash
npx biome check src/path/to/file.ts         # Check one file
npx biome check src/ --apply                # Auto-fix where safe
```

## Related
- [[testing]] — test mapping by changed file
- [[peer-deps]] — build ignores optional peers
