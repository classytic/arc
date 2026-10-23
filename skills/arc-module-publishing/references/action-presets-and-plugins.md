# Action presets and plugins

## Action preset: verbs on one resource

A function returning an `actions` slice. No lifecycle, no engine. The host spreads it into `defineResource`.

```ts
import { defineAction } from "@classytic/arc/core";
import type { PermissionCheck } from "@classytic/arc/permissions";
import { getOrgId } from "@classytic/arc/scope";
import type { ActionDefinition } from "@classytic/arc/types";
import { createDomainError, NotFoundError } from "@classytic/arc/utils";
import { z } from "zod";

const flagBody = z.object({ reason: z.string().trim().min(3) });

export interface WithFlagConfig<TDoc> {
  readonly repository: {
    getById(id: string, o: { organizationId?: string; throwOnNotFound: false; lean: true }): Promise<TDoc | null>;
    update(id: string, patch: Record<string, unknown>, o: { organizationId?: string; lean: true }): Promise<TDoc | null>;
  };
  readonly permissions: { readonly flag: PermissionCheck };
  readonly tenancy?: "required" | "off";
}

export function withFlag<TDoc>(cfg: WithFlagConfig<TDoc>): Record<"flag", ActionDefinition> {
  return {
    flag: defineAction({
      schema: flagBody,
      parse: true,
      permissions: cfg.permissions.flag,
      description: "Flag the subject for review.",
      handler: async (id, data, req) => {
        const organizationId = cfg.tenancy === "off" ? undefined : getOrgId(req.scope);
        const doc = await cfg.repository.getById(id, { organizationId, throwOnNotFound: false, lean: true });
        if (!doc) throw new NotFoundError("subject not found");
        if ((doc as { flagged?: boolean }).flagged) throw createDomainError("subject.already_flagged", "Already flagged", 409);
        return cfg.repository.update(id, { flagged: true, flagReason: data.reason }, { organizationId, lean: true });
      },
    }),
  };
}
```

Host:

```ts
defineResource({
  name: "ticket",
  adapter,
  actions: { ...withFlag({ repository, permissions: { flag: requireRoles(["admin"]) } }) },
});
// POST /tickets/:id/action  { "action": "flag", "reason": "spam" }
```

### Rules for a reusable preset

- Inject all policy (permissions, resolvers, side-effect hooks, tenancy mode). The preset owns mechanism, the host owns policy.
- Take a structural port, never a kit type.
- Read tenant and user through `getOrgId` or `requireOrgId` on `req.scope`. Support `tenancy: "required" | "off"`.
- Declare the body once: zod v4 plus `parse: true`, or JSON Schema. An empty body uses `noPayloadSchema`.
- Map domain failures to `createDomainError(code, message, status)` so the wire stays the ErrorContract.
- Model a mode as a discriminated field (`source: "literal" | "policy"`), not a boolean flag.
- `defineAction({ id: false })` mounts the verb at `POST /<prefix>/action` with no `:id`.

## Plugin: cross-cutting decorator or hook

`createPlugin` gives a global `forRoot` and a per-resource `forResource` slice. No `fastify-plugin` import needed.

```ts
import { createPlugin } from "@classytic/arc/plugins";

export const analytics = createPlugin<{ apiKey: string }, { track: boolean }>("analytics", {
  forRoot: async (fastify, opts) => {
    fastify.decorate("analytics", createClient(opts.apiKey));
  },
  forResource: (opts) => (opts.track ? { hooks: [] } : {}),
});

// host
await app.register(analytics.forRoot({ apiKey }));
defineResource({ name: "product", adapter, ...analytics.forResource({ track: true }) });
```

- Set response headers in `onRequest` or `preSerialization`, never in an async `onSend`.
- A plugin owned by a domain module is registered inside the module's `plugins` phase: `await fastify.register(x)`.
- Scheduled work in a package ships as module `scheduledJobs`; a once-per-local-day job sets `daily: { hour, minute?, zone, ledger }` and the host supplies the `DailyLedger`.
