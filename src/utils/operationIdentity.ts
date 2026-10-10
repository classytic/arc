/** Security context included in idempotency identities across transports. */
import { createHash } from "node:crypto";
import type { RequestScope } from "../scope/types.js";

export function operationIdentity(
  operation: string,
  scope: RequestScope | undefined,
  fallbackPrincipal?: string,
  namespace?: string,
): string {
  const principal =
    scope?.kind === "service"
      ? scope.clientId
      : scope?.kind === "public"
        ? fallbackPrincipal
        : (scope?.userId ?? fallbackPrincipal);
  const org = scope && "organizationId" in scope ? scope.organizationId : undefined;
  const team = scope && "teamId" in scope ? scope.teamId : undefined;
  const context =
    scope && "context" in scope
      ? Object.entries(scope.context ?? {}).sort(([a], [b]) => a.localeCompare(b))
      : [];
  const identity = JSON.stringify([
    namespace ?? "",
    operation,
    scope?.kind ?? "public",
    principal ?? "anon",
    org ?? null,
    team ?? null,
    context,
  ]);
  return createHash("sha256").update(identity).digest("hex");
}
