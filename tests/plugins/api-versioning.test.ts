/**
 * API Versioning Plugin Tests
 *
 * Verifies header-based and prefix-based API versioning.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

describe('API Versioning Plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Header-based versioning
  // ==========================================================================

  describe('Header-based versioning', () => {
    it('should extract version from Accept-Version header', async () => {
      const { versioningPlugin } = await import('../../src/plugins/versioning.js');

      app = Fastify({ logger: false });
      await app.register(versioningPlugin, { type: 'header' });

      app.get('/test', async (request) => {
        return { version: (request as unknown as { apiVersion: string }).apiVersion };
      });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'accept-version': '2' },
      });

      expect(JSON.parse(res.body).version).toBe('2');
    });

    it('should default to version 1 when no header present', async () => {
      const { versioningPlugin } = await import('../../src/plugins/versioning.js');

      app = Fastify({ logger: false });
      await app.register(versioningPlugin, { type: 'header', defaultVersion: '1' });

      app.get('/test', async (request) => {
        return { version: (request as unknown as { apiVersion: string }).apiVersion };
      });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/test' });
      expect(JSON.parse(res.body).version).toBe('1');
    });

    it('should include version in response header', async () => {
      const { versioningPlugin } = await import('../../src/plugins/versioning.js');

      app = Fastify({ logger: false });
      await app.register(versioningPlugin, { type: 'header' });

      app.get('/test', async () => ({ ok: true }));
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'accept-version': '3' },
      });

      expect(res.headers['x-api-version']).toBe('3');
    });
  });

  // ==========================================================================
  // Prefix-based versioning
  // ==========================================================================

  describe('Prefix-based versioning', () => {
    it('should extract version from URL prefix /v{n}', async () => {
      const { versioningPlugin } = await import('../../src/plugins/versioning.js');

      app = Fastify({ logger: false });
      await app.register(versioningPlugin, { type: 'prefix' });

      app.get('/v2/test', async (request) => {
        return { version: (request as unknown as { apiVersion: string }).apiVersion };
      });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/v2/test' });
      expect(JSON.parse(res.body).version).toBe('2');
    });

    it('should default to version 1 for non-versioned paths', async () => {
      const { versioningPlugin } = await import('../../src/plugins/versioning.js');

      app = Fastify({ logger: false });
      await app.register(versioningPlugin, { type: 'prefix', defaultVersion: '1' });

      app.get('/test', async (request) => {
        return { version: (request as unknown as { apiVersion: string }).apiVersion };
      });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/test' });
      expect(JSON.parse(res.body).version).toBe('1');
    });
  });

  // ==========================================================================
  // Version deprecation
  // ==========================================================================

  describe('Version deprecation', () => {
    it('should add Deprecation header for deprecated versions', async () => {
      const { versioningPlugin } = await import('../../src/plugins/versioning.js');

      app = Fastify({ logger: false });
      await app.register(versioningPlugin, {
        type: 'header',
        deprecated: ['1'],
      });

      app.get('/test', async () => ({ ok: true }));
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'accept-version': '1' },
      });

      expect(res.headers['deprecation']).toBe('true');
      expect(res.headers['sunset']).toBeDefined();
    });

    it('should NOT add Deprecation header for current versions', async () => {
      const { versioningPlugin } = await import('../../src/plugins/versioning.js');

      app = Fastify({ logger: false });
      await app.register(versioningPlugin, {
        type: 'header',
        deprecated: ['1'],
      });

      app.get('/test', async () => ({ ok: true }));
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'accept-version': '2' },
      });

      expect(res.headers['deprecation']).toBeUndefined();
    });
  });
});
