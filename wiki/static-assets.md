# Static assets

**Summary**: `createApp({ assets })` — arc supplies header POLICY over `@fastify/static`, which owns every transport mechanic. The header that actually breaks cross-origin assets is `Cross-Origin-Resource-Policy`, not CORS.
**Sources**: src/factory/assets.ts, src/factory/types/assets.ts.
**Last updated**: 2026-07-29 (page created — 2.31).

---

## The bug this exists to fix

Arc enables `@fastify/helmet` by default, and helmet's defaults include
`Cross-Origin-Resource-Policy: same-origin`. That tells the browser to refuse to
**embed** the response in any cross-origin document — `<img>`, `<audio>`,
`<video>`, fonts, stylesheets.

The request returns **200**, CORS negotiates correctly, and the browser silently
discards the body with `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` — naming neither
CORS nor arc. So a frontend on a different origin than the API cannot render an
uploaded image regardless of the CORS list, and **a hand-rolled static route hits
it too**, because the header comes from the app, not the route.

```ts
createApp({
  assets: [{ prefix: "/uploads", root: "./var/uploads", crossOrigin: "same-site" }],
})
```

`crossOrigin` sets CORP for **that prefix only** — the API surface keeps
`same-origin`. That scoping is pinned by a test.

## Defaults, and why

| Option | Default | Why |
|---|---|---|
| `crossOrigin` | `same-site` | Covers the `api.` → `app.` split; still refuses an unrelated origin. `cross-origin` permits **any** site to embed and hotlink — opt in. |
| `cache` | `revalidate` | Arc cannot know whether filenames are hashed. `immutable` on a mutable path serves stale bytes for a year with no recovery. `ETag` makes the steady state a 304, so the safe default is also cheap. |
| `disposition` | `attachment` | Serving untrusted uploads `inline` is stored XSS — an uploaded `.svg`/`.html` executes on your origin with your cookies. |
| dotfiles | refused (403) | `.env`, `.git/config` get deployed by accident. |
| `list` | off | A directory listing enumerates the whole root. |

Arc also sets `X-Content-Type-Options: nosniff` unconditionally, and
`Vary: Origin, Accept-Encoding` whenever the response is not `same-origin`.

## What arc does NOT implement

Byte ranges, `ETag`/`Last-Modified` conditional requests, `immutable`
directives, pre-compressed `.br`/`.gz` sibling selection, `reply.sendFile()` —
all `@fastify/static`. Arc turns them **on** and never re-derives them.

## Two traps

**`allowedPath` is synchronous by contract** (`(pathName, root, request) => boolean`),
so an async `PermissionCheck` cannot run inside it. That makes it the right home
for a **signed-URL** check — HMAC verification is sync, needs no database, and
stays CDN-cacheable. For an async gate, put a `preHandler` on the prefix.

**`preCompressed` bypasses extension rules.** `allowedPath` runs against the
requested path *before* the variant is chosen, so denying `*.gz` does not stop
`/main.js` serving `main.js.gz`. Treat pre-compressed files as public alternate
encodings; keep anything restricted out of the served root.

## Per-route CORS

One app-wide policy cannot serve both surfaces: an API wants `credentials: true`
with a pinned origin list, a public asset wants `origin: "*"`, and `*` +
credentials is forbidden by the spec (arc throws at boot on that pair).
`RouteDefinition.cors` forwards to Fastify's `routeOptions.config.cors`, which
`@fastify/cors` reads as an override — `false` disables CORS for the route.

```ts
{ method: "GET", path: "/manifest.json", permissions: allowPublic(),
  cors: { origin: "*", credentials: false }, handler }
```

## Related
- [[peer-deps]] — `@fastify/static` is an optional peer
- [[security]] — checklist when touching auth/perms/data
