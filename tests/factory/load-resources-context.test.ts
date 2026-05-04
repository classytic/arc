/**
 * loadResources — context bag + factory-export support (2.11.1).
 *
 * Default exports may now be either:
 *   1. a `ResourceLike` (the `defineResource()` instance) — pre-2.11.1 behavior
 *   2. a function `(ctx) => ResourceLike | Promise<ResourceLike>` — new
 *
 * Detection is unambiguous: `defineResource()` returns a class instance
 * (`typeof === 'object'`), so a function-typed default export means
 * "factory — call me with `options.context`".
 *
 * This closes the host-side scaling pain that engine-bound resources
 * historically created (parallel `createXResource(engine)` factory files
 * outside the auto-discovery sweep + a stringly-typed `exclude: [...]`
 * list against resource names).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadResources } from "../../src/factory/loadResources.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

const ARC_ROOT = resolve(import.meta.dirname, "../..").replace(/\\/g, "/");
const FIXTURE_DIR = join(import.meta.dirname, "__fixtures_lr_ctx__");

// ============================================================================
// Fixture builders
// ============================================================================

/**
 * Plain `ResourceLike` default export — the pre-2.11.1 shape. Must keep
 * working unchanged after the context-bag widening.
 */
function plainResourceFile(modelName: string, resourceName: string): string {
  return `
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { defineResource } from '${ARC_ROOT}/src/core/defineResource.js';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { BaseController } from '${ARC_ROOT}/src/core/BaseController.js';
import { allowPublic } from '${ARC_ROOT}/src/permissions/index.js';

const S = new mongoose.Schema({ name: String }, { timestamps: true });
const M = mongoose.models.${modelName} || mongoose.model('${modelName}', S);
const r = new Repository(M);

export default defineResource({
  name: '${resourceName}',
  adapter: createMongooseAdapter({ model: M, repository: r }),
  controller: new BaseController(r, { resourceName: '${resourceName}' }),
  permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic(), update: allowPublic(), delete: allowPublic() },
});
`;
}

/**
 * Factory default export — the 2.11.1 shape. Receives `ctx` from
 * `loadResources(..., { context })` and returns the `ResourceLike`.
 * The factory uses `ctx.tag` to namespace the resource, proving the
 * context actually flows through.
 */
function factoryResourceFile(modelName: string, baseName: string): string {
  return `
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { defineResource } from '${ARC_ROOT}/src/core/defineResource.js';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { BaseController } from '${ARC_ROOT}/src/core/BaseController.js';
import { allowPublic } from '${ARC_ROOT}/src/permissions/index.js';

const S = new mongoose.Schema({ name: String }, { timestamps: true });
const M = mongoose.models.${modelName} || mongoose.model('${modelName}', S);
const r = new Repository(M);

// Factory default — call with context from loadResources.
export default (ctx) => defineResource({
  name: ctx.tag + '-${baseName}',
  adapter: createMongooseAdapter({ model: M, repository: r }),
  controller: new BaseController(r, { resourceName: ctx.tag + '-${baseName}' }),
  permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic(), update: allowPublic(), delete: allowPublic() },
});
`;
}

/**
 * Async factory default export — same as above but returns a Promise.
 * Engine-bound resources may need to await DB lookups inside the factory.
 */
function asyncFactoryResourceFile(modelName: string, baseName: string): string {
  return `
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { defineResource } from '${ARC_ROOT}/src/core/defineResource.js';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { BaseController } from '${ARC_ROOT}/src/core/BaseController.js';
import { allowPublic } from '${ARC_ROOT}/src/permissions/index.js';

const S = new mongoose.Schema({ name: String }, { timestamps: true });
const M = mongoose.models.${modelName} || mongoose.model('${modelName}', S);
const r = new Repository(M);

export default async (ctx) => {
  // Simulate an async lookup (e.g. engine.repositories.X).
  await Promise.resolve();
  return defineResource({
    name: ctx.tag + '-${baseName}',
    adapter: createMongooseAdapter({ model: M, repository: r }),
    controller: new BaseController(r, { resourceName: ctx.tag + '-${baseName}' }),
    permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic(), update: allowPublic(), delete: allowPublic() },
  });
};
`;
}

/** A factory that returns garbage — should land in `factoryFailed`, not `skipped`. */
function brokenFactoryFile(): string {
  return `
export default (ctx) => ({ notAResource: true });
`;
}

/** A factory that throws — should land in `factoryFailed`. */
function throwingFactoryFile(): string {
  return `
export default (ctx) => {
  throw new Error('boom');
};
`;
}

// ============================================================================
// Tests
// ============================================================================

describe("loadResources — context bag (2.11.1)", () => {
  beforeAll(async () => {
    await setupTestDatabase();
    mkdirSync(FIXTURE_DIR, { recursive: true });

    writeFileSync(
      join(FIXTURE_DIR, "plain.resource.mjs"),
      plainResourceFile("LRCtxPlain", "plain-resource"),
    );
    writeFileSync(
      join(FIXTURE_DIR, "factory.resource.mjs"),
      factoryResourceFile("LRCtxFactory", "factory-resource"),
    );
    writeFileSync(
      join(FIXTURE_DIR, "async-factory.resource.mjs"),
      asyncFactoryResourceFile("LRCtxAsync", "async-resource"),
    );
    writeFileSync(join(FIXTURE_DIR, "broken-factory.resource.mjs"), brokenFactoryFile());
    writeFileSync(join(FIXTURE_DIR, "throwing-factory.resource.mjs"), throwingFactoryFile());
  });

  afterAll(async () => {
    if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
    await teardownTestDatabase();
  });

  // Suppress arc's default warn-on-factory-failure for the cases where
  // we intentionally include broken fixtures only to verify the *passing*
  // ones load. The dedicated failure tests below assert via injected
  // logger so they don't need this.
  const noopLogger = { warn: () => undefined };

  it("plain ResourceLike default exports load unchanged (back-compat)", async () => {
    const resources = await loadResources(FIXTURE_DIR, {
      include: ["plain-resource"],
      logger: noopLogger,
    });
    expect(resources).toHaveLength(1);
    expect(resources[0].name).toBe("plain-resource");
  });

  it("factory default export receives `context` and produces a ResourceLike", async () => {
    type Ctx = { tag: string };
    const resources = await loadResources<Ctx>(FIXTURE_DIR, {
      include: ["v1-factory-resource"],
      context: { tag: "v1" },
      logger: noopLogger,
    });
    expect(resources).toHaveLength(1);
    expect(resources[0].name).toBe("v1-factory-resource");
  });

  it("async factory default exports are awaited", async () => {
    type Ctx = { tag: string };
    const resources = await loadResources<Ctx>(FIXTURE_DIR, {
      include: ["v2-async-resource"],
      context: { tag: "v2" },
      logger: noopLogger,
    });
    expect(resources).toHaveLength(1);
    expect(resources[0].name).toBe("v2-async-resource");
  });

  it("plain + factory exports coexist in one sweep", async () => {
    type Ctx = { tag: string };
    const resources = await loadResources<Ctx>(FIXTURE_DIR, {
      include: ["plain-resource", "co-factory-resource", "co-async-resource"],
      context: { tag: "co" },
      logger: noopLogger,
    });
    expect(resources).toHaveLength(3);
    const names = resources.map((r) => r.name).sort();
    expect(names).toEqual(["co-async-resource", "co-factory-resource", "plain-resource"]);
  });

  it("factory that returns non-resource is reported as a factory failure", async () => {
    const warnings: string[] = [];
    const resources = await loadResources(FIXTURE_DIR, {
      include: ["__never_matches__"],
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(resources).toHaveLength(0);
    const factoryFailureWarn = warnings.find((w) => w.includes("factory export(s) failed"));
    expect(factoryFailureWarn).toBeDefined();
    expect(warnings.some((w) => w.includes("factory returned non-resource value"))).toBe(true);
  });

  it("factory that throws is reported as a factory failure (file path included)", async () => {
    const warnings: string[] = [];
    await loadResources(FIXTURE_DIR, {
      include: ["__never_matches__"],
      logger: { warn: (msg) => warnings.push(msg) },
    });
    const threwWarn = warnings.find((w) => w.includes("factory threw: boom"));
    expect(threwWarn).toBeDefined();
  });

  it("missing `context` — factory receives undefined and may fail safely", async () => {
    // Factory dereferences ctx.tag without context — should land in
    // factoryFailed, not skipped (it's an exception, not a missing toPlugin).
    const warnings: string[] = [];
    const resources = await loadResources(FIXTURE_DIR, {
      include: ["__no_match__"],
      logger: { warn: (msg) => warnings.push(msg) },
      // context omitted on purpose
    });
    expect(resources).toHaveLength(0);
    expect(warnings.some((w) => w.includes("factory threw"))).toBe(true);
  });
});
