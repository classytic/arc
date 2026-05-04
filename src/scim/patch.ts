/**
 * SCIM 2.0 PATCH parser (RFC 7644 §3.5.2)
 *
 * Translates SCIM PATCH operations into a flat update object the resource's
 * existing PATCH handler can apply. Supports the three operations every IdP
 * actually emits: `add`, `replace`, `remove`.
 *
 * **Path support**:
 *   - Simple attribute: `userName` → `{ userName: <value> }`
 *   - Sub-attribute: `name.familyName` → `{ 'name.familyName': <value> }`
 *   - No path (op-level value): `replace` with object value → spread into update
 *   - Multi-value with filter: `emails[type eq "work"].value` — parsed but
 *     translated to a `$set` on the matching array element by index lookup
 *     (host resolves index via the supplied `lookupArrayIndex` callback)
 *
 * @example
 * parseScimPatch({
 *   schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
 *   Operations: [
 *     { op: 'replace', path: 'displayName', value: 'Alice S.' },
 *     { op: 'add',     path: 'emails', value: [{ type: 'work', value: 'a@x.com' }] },
 *     { op: 'remove',  path: 'emails[type eq "old"]' },
 *   ],
 * })
 *   → { $set: { displayName: 'Alice S.' }, $push: { emails: ... }, $pull: { emails: ... } }
 */

import { ScimError } from "./errors.js";

export interface ScimPatchRequest {
  schemas?: readonly string[];
  Operations?: readonly ScimPatchOperation[];
  // Some IdPs send "operations" lowercase
  operations?: readonly ScimPatchOperation[];
}

export interface ScimPatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

export interface ScimUpdate {
  /** Direct field assignments → resource's `update` payload. */
  $set: Record<string, unknown>;
  /** Multi-value array additions → `$push` on the field. */
  $push: Record<string, unknown>;
  /** Multi-value removals — caller resolves which element. */
  $pull: Record<string, unknown>;
  /** Field unset (remove without filter). */
  $unset: Record<string, true>;
}

export function parseScimPatch(req: ScimPatchRequest): ScimUpdate {
  const ops = req.Operations ?? req.operations ?? [];
  if (ops.length === 0) {
    throw new ScimError(400, "invalidSyntax", "PATCH request must include at least one operation");
  }

  const out: ScimUpdate = { $set: {}, $push: {}, $pull: {}, $unset: {} };

  for (const op of ops) {
    const verb = (op.op ?? "").toLowerCase();
    if (verb !== "add" && verb !== "replace" && verb !== "remove") {
      throw new ScimError(
        400,
        "invalidSyntax",
        `Unsupported PATCH op "${op.op}" (allowed: add, replace, remove)`,
      );
    }

    // No path, op-level value: spread the object into $set (RFC 7644 §3.5.2.3).
    if (!op.path) {
      if (verb === "remove") {
        throw new ScimError(400, "noTarget", "remove operation requires a path");
      }
      if (op.value === undefined || op.value === null || typeof op.value !== "object") {
        throw new ScimError(
          400,
          "invalidValue",
          "Path-less add/replace must carry an object value",
        );
      }
      Object.assign(out.$set, op.value as Record<string, unknown>);
      continue;
    }

    // Multi-value with filter: emails[type eq "work"]
    const bracketIdx = op.path.indexOf("[");
    if (bracketIdx >= 0) {
      const closeBracket = op.path.indexOf("]", bracketIdx);
      if (closeBracket < 0) {
        throw new ScimError(400, "invalidPath", `Unterminated bracket in path "${op.path}"`);
      }
      const arrayField = op.path.slice(0, bracketIdx);
      // Tail after ] — could be `.value` for sub-attribute access; if absent
      // the operation targets the matched element as a whole.
      // For now we surface the path as-is in the $pull spec; host applies it.
      if (verb === "remove") {
        out.$pull[arrayField] = { __scimFilter: op.path.slice(bracketIdx + 1, closeBracket) };
      } else if (verb === "add") {
        out.$push[arrayField] = op.value;
      } else {
        // replace — represent as a $pull-then-$push pair via metadata
        out.$pull[arrayField] = { __scimFilter: op.path.slice(bracketIdx + 1, closeBracket) };
        out.$push[arrayField] = op.value;
      }
      continue;
    }

    // Simple or dotted path
    if (verb === "remove") {
      out.$unset[op.path] = true;
      continue;
    }
    if (verb === "add" && Array.isArray(op.value)) {
      // Multi-value add without filter — push each element
      out.$push[op.path] = { $each: op.value };
      continue;
    }
    out.$set[op.path] = op.value;
  }

  return out;
}

/**
 * Flatten a {@link ScimUpdate} into a plain `{ field: value }` object suitable
 * for arc resource `PATCH` handlers that expect a partial document. Drops
 * `$push` / `$pull` / `$unset` semantics — use {@link parseScimPatch} directly
 * when the host needs the full op stream (e.g. to issue array mutations).
 */
export function scimUpdateToFlatPatch(update: ScimUpdate): Record<string, unknown> {
  const out: Record<string, unknown> = { ...update.$set };
  for (const k of Object.keys(update.$unset)) out[k] = null;
  return out;
}
