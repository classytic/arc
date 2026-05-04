/**
 * SCIM 2.0 ↔ arc resource mapping
 *
 * Most arc apps store users / orgs in a shape that doesn't match SCIM
 * verbatim. This module owns the bidirectional translation:
 *
 *   - **Inbound** (`scimToResource`): SCIM JSON → arc resource shape
 *   - **Outbound** (`resourceToScim`): arc resource → SCIM JSON
 *
 * Defaults track Better Auth's `user` / `organization` schema so apps using
 * the BA overlay get a working SCIM endpoint with zero mapping config.
 */

/**
 * Mapping spec for a single SCIM resource type. Apps override only the
 * fields that diverge from the BA defaults.
 */
export interface ScimResourceMapping {
  /** SCIM resource schema URI (e.g. `urn:ietf:params:scim:schemas:core:2.0:User`). */
  schema: string;
  /**
   * SCIM attribute → backend field. Used by both filter parser and
   * outbound serializer. Omit an attribute to mark it non-filterable.
   */
  attributes: Record<string, string>;
  /** Inverse for outbound serialization — built from `attributes` by default. */
  reverseAttributes?: Record<string, string>;
  /** Custom inbound transform — runs after attribute mapping. */
  fromScim?: (
    scim: Record<string, unknown>,
    mapped: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** Custom outbound transform — runs after attribute mapping. */
  toScim?: (
    resource: Record<string, unknown>,
    mapped: Record<string, unknown>,
  ) => Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────
// SCIM core User schema mapping (RFC 7643 §4.1) — BA-aligned defaults
// ─────────────────────────────────────────────────────────────────────

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_ENTERPRISE_USER_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

export const DEFAULT_USER_MAPPING: ScimResourceMapping = {
  schema: SCIM_USER_SCHEMA,
  attributes: {
    id: "id",
    userName: "email",
    "name.formatted": "name",
    displayName: "name",
    "emails.value": "email",
    active: "isActive",
    externalId: "externalId",
    "meta.created": "createdAt",
    "meta.lastModified": "updatedAt",
  },
};

export const DEFAULT_GROUP_MAPPING: ScimResourceMapping = {
  schema: SCIM_GROUP_SCHEMA,
  attributes: {
    id: "id",
    displayName: "name",
    externalId: "externalId",
    "meta.created": "createdAt",
    "meta.lastModified": "updatedAt",
  },
};

// ─────────────────────────────────────────────────────────────────────
// Bidirectional translation
// ─────────────────────────────────────────────────────────────────────

function buildReverseMap(forward: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [scim, backend] of Object.entries(forward)) {
    if (!(backend in out)) out[backend] = scim;
  }
  return out;
}

function getDeep(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

function setDeep(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
}

/** Translate inbound SCIM JSON → resource shape. */
export function scimToResource(
  scim: Record<string, unknown>,
  mapping: ScimResourceMapping,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [scimAttr, backendField] of Object.entries(mapping.attributes)) {
    const v = getDeep(scim, scimAttr);
    if (v !== undefined && v !== null && v !== "") {
      mapped[backendField] = v;
    }
  }
  // SCIM `emails` arrives as `[{ value, primary, type }]` — pick primary if present.
  if (Array.isArray(scim.emails)) {
    const list = scim.emails as Array<{ value?: string; primary?: boolean }>;
    const primary = list.find((e) => e.primary === true) ?? list[0];
    if (primary?.value && mapping.attributes["emails.value"]) {
      mapped[mapping.attributes["emails.value"]] = primary.value;
    }
  }
  return mapping.fromScim ? mapping.fromScim(scim, mapped) : mapped;
}

/** Translate resource → SCIM JSON. */
export function resourceToScim(
  resource: Record<string, unknown>,
  mapping: ScimResourceMapping,
  baseUrl: string,
): Record<string, unknown> {
  const reverse = mapping.reverseAttributes ?? buildReverseMap(mapping.attributes);
  const out: Record<string, unknown> = {
    schemas: [mapping.schema],
  };
  for (const [backendField, value] of Object.entries(resource)) {
    if (value === undefined || value === null) continue;
    const scimAttr = reverse[backendField];
    if (!scimAttr) continue;
    setDeep(out, scimAttr, value);
  }
  // SCIM `emails` array — reconstruct from primary email.
  const primaryEmail = resource[mapping.attributes["emails.value"] ?? "email"];
  if (primaryEmail) {
    out.emails = [{ value: primaryEmail, primary: true, type: "work" }];
  }
  // meta.resourceType + meta.location — SCIM-required.
  const id = (resource.id ?? resource._id) as string | undefined;
  if (id) {
    const resourceType = mapping.schema.endsWith("User") ? "User" : "Group";
    const meta = (out.meta as Record<string, unknown>) ?? {};
    meta.resourceType = resourceType;
    meta.location = `${baseUrl}/${resourceType}s/${id}`;
    out.meta = meta;
  }
  return mapping.toScim ? mapping.toScim(resource, out) : out;
}
