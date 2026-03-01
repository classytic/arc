# Arc Examples (Maintained)

These examples are intentionally curated and kept aligned with the current Arc API surface.

- `01-minimal.ts` - Smallest resource setup with `defineResource` + `createMongooseAdapter`
- `01-basic-crud.ts` - Standard CRUD resource with presets and custom route
- `03-multi-tenant.ts` - Multi-tenant resource using `multiTenant` preset

Notes:
- Use `createApp` from `@classytic/arc/factory`.
- Keep examples focused on stable APIs from `packages/arc/src`.
- Move advanced or experimental flows to docs pages until they are API-stable.
