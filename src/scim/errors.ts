/**
 * SCIM 2.0 error responses (RFC 7644 §3.12)
 *
 * Wire shape:
 * ```json
 * {
 *   "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
 *   "status": "400",
 *   "scimType": "invalidFilter",
 *   "detail": "Attribute 'xyz' is not filterable"
 * }
 * ```
 */

export type ScimType =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue"
  | "invalidVers"
  | "sensitive";

export class ScimError extends Error {
  readonly statusCode: number;
  readonly scimType?: ScimType;

  constructor(statusCode: number, scimType: ScimType | undefined, detail: string) {
    super(detail);
    this.statusCode = statusCode;
    this.scimType = scimType;
    this.name = "ScimError";
  }

  toResponse(): Record<string, unknown> {
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(this.statusCode),
      ...(this.scimType ? { scimType: this.scimType } : {}),
      detail: this.message,
    };
  }
}
