/**
 * Regression: 2.10.6 auto-injected `systemManaged: true` +
 * `preserveForElevated: true` on the tenant field's `fieldRules`, but the
 * inject lived on `resolvedConfig.schemaOptions` while
 * `defineResource.ts` still passed the pre-inject `config.schemaOptions`
 * to `adapter.generateSchemas()`.
 *
 * Net effect of the 2.10.6 bug:
 * - `BodySanitizer` (reads resolvedConfig) correctly stripped tenant fields.
 * - Adapter's OpenAPI / MCP body-schema generators (got raw `config`) still
 *   saw the tenant field as a regular writable input, so generated schemas
 *   advertised `organizationId` as required even though the runtime
 *   stripped it — half-wired.
 *
 * 2.10.7 fixes the forwarding: `generateSchemas(resolvedConfig.schemaOptions, …)`.
 * This test asserts the adapter actually sees the injected rule.
 */

import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { DataAdapter, RepositoryLike, RouteSchemaOptions } from "../../src/types/index.js";

describe("2.10.7 regression — adapter.generateSchemas sees auto-injected tenant fieldRules", () => {
  interface InvoiceDoc {
    _id?: string;
    organizationId?: string;
    number: string;
    amount: number;
  }

  /**
   * Stub adapter that records the `schemaOptions.fieldRules` it was called
   * with, so the test can assert the auto-injected rule was forwarded.
   */
  function buildRecordingAdapter(): DataAdapter<InvoiceDoc> & {
    captured: { schemaOptions: RouteSchemaOptions | undefined; calls: number };
  } {
    const captured = { schemaOptions: undefined as RouteSchemaOptions | undefined, calls: 0 };
    const repo = {
      async getAll() {
        return { docs: [], total: 0 };
      },
      async getById() {
        return null;
      },
      async create(d: Partial<InvoiceDoc>) {
        return d as InvoiceDoc;
      },
      async update() {
        return null;
      },
      async delete() {
        return { acknowledged: true, deletedCount: 0 };
      },
    } satisfies RepositoryLike<InvoiceDoc>;

    return {
      repository: repo,
      type: "mock",
      name: "recording-adapter",
      generateSchemas(options) {
        captured.calls += 1;
        captured.schemaOptions = options;
        // Minimal schema so defineResource doesn't reject the return shape.
        return {
          createBody: { type: "object", properties: {}, required: [] },
          updateBody: { type: "object", properties: {} },
        };
      },
      captured,
    } as DataAdapter<InvoiceDoc> & {
      captured: { schemaOptions: RouteSchemaOptions | undefined; calls: number };
    };
  }

  it("passes `resolvedConfig.schemaOptions` (with auto-inject) to the adapter", () => {
    const adapter = buildRecordingAdapter();

    defineResource<InvoiceDoc>({
      name: "invoice",
      tenantField: "organizationId",
      adapter,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // Adapter was called at least once
    expect(adapter.captured.calls).toBeGreaterThan(0);

    // The fieldRules it saw include the auto-injected tenant rule.
    // Before the 2.10.7 fix, `config.schemaOptions` was forwarded (raw,
    // no injection) — so `fieldRules` was undefined and this assertion
    // failed.
    const rules = adapter.captured.schemaOptions?.fieldRules;
    expect(rules).toBeDefined();
    expect(rules?.organizationId?.systemManaged).toBe(true);
    expect(rules?.organizationId?.preserveForElevated).toBe(true);
  });

  it("respects a caller-supplied fieldRules for the tenant field (no overwrite)", () => {
    const adapter = buildRecordingAdapter();

    defineResource<InvoiceDoc>({
      name: "invoice-custom",
      tenantField: "organizationId",
      adapter,
      schemaOptions: {
        fieldRules: {
          organizationId: { systemManaged: false, description: "Host override" },
        },
      },
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const rules = adapter.captured.schemaOptions?.fieldRules;
    expect(rules).toBeDefined();
    expect(rules?.organizationId?.systemManaged).toBe(false);
    expect(rules?.organizationId?.description).toBe("Host override");
  });

  it("uses the configured tenantField name (not hard-coded to organizationId)", () => {
    interface Widget {
      _id?: string;
      accountId?: string;
      kind: string;
    }
    const captured = { schemaOptions: undefined as RouteSchemaOptions | undefined };
    const adapter: DataAdapter<Widget> = {
      repository: {
        async getAll() {
          return { docs: [], total: 0 };
        },
        async getById() {
          return null;
        },
        async create(d: Partial<Widget>) {
          return d as Widget;
        },
        async update() {
          return null;
        },
        async delete() {
          return { acknowledged: true, deletedCount: 0 };
        },
      } satisfies RepositoryLike<Widget>,
      type: "mock",
      name: "widget-adapter",
      generateSchemas(options) {
        captured.schemaOptions = options;
        return { createBody: { type: "object" } };
      },
    };

    defineResource<Widget>({
      name: "widget",
      tenantField: "accountId",
      adapter,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    expect(captured.schemaOptions?.fieldRules?.accountId?.systemManaged).toBe(true);
    expect(captured.schemaOptions?.fieldRules?.organizationId).toBeUndefined();
  });
});
