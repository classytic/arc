# Arc Full Example App

A complete, runnable example demonstrating Arc's core features:

- `defineResource()` with CRUD, presets, permissions, hooks, and events
- JWT auth with role-based access control
- Sub-resources (posts belong to users)
- Custom action routes
- Full test suite using Arc's `HttpTestHarness`

## Structure

```
full-app/
├── app.ts                 # createApp bootstrap
├── resources/
│   ├── user.resource.ts   # User resource (admin-managed)
│   └── post.resource.ts   # Post resource (owner-writable, public-readable)
├── tests/
│   ├── setup.ts           # Shared test setup (MongoDB + Fastify)
│   ├── user.test.ts       # User CRUD tests
│   └── post.test.ts       # Post CRUD + custom action tests
└── README.md
```

## Running

These tests run as part of Arc's test suite:

```bash
npx vitest run examples/full-app/tests/
```
