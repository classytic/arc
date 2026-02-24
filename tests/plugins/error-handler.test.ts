/**
 * Error Handler Plugin Tests
 *
 * Tests all error type handling:
 * - ArcError (custom status/code/details)
 * - Fastify validation errors (schema validation)
 * - CastError → 400 INVALID_ID
 * - Mongoose ValidationError → 400 VALIDATION_ERROR
 * - MongoDB duplicate key (11000) → 409 DUPLICATE_KEY
 * - Custom errorMap
 * - Stack trace exposure control
 * - onError callback
 *
 * NOTE: Fastify 5 does not allow route registration after ready().
 * All routes are registered via the registerRoutes callback before ready().
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandlerPlugin } from '../../src/plugins/errorHandler.js';
import { ArcError, NotFoundError, ValidationError, ForbiddenError } from '../../src/utils/errors.js';

describe('Error Handler Plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  /**
   * Create a test app with error handler + test routes.
   * Routes MUST be registered before app.ready() in Fastify 5.
   */
  async function createApp(
    opts: Record<string, unknown> = {},
    registerRoutes?: (instance: FastifyInstance) => void,
  ) {
    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin, opts);

    if (registerRoutes) {
      registerRoutes(app);
    }

    await app.ready();
    return app;
  }

  // ========================================================================
  // ArcError Handling
  // ========================================================================

  describe('ArcError handling', () => {
    it('should handle ArcError with custom status/code/details', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/arc-error', async () => {
          throw new ArcError('Something broke', {
            statusCode: 422,
            code: 'CUSTOM_CODE',
            details: { field: 'email', reason: 'invalid format' },
          });
        });
      });

      const res = await app.inject({ method: 'GET', url: '/arc-error' });
      expect(res.statusCode).toBe(422);

      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Something broke');
      expect(body.code).toBe('CUSTOM_CODE');
      expect(body.details.field).toBe('email');
      expect(body.timestamp).toBeDefined();
    });

    it('should handle NotFoundError', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/not-found', async () => {
          throw new NotFoundError('Product', '12345');
        });
      });

      const res = await app.inject({ method: 'GET', url: '/not-found' });
      expect(res.statusCode).toBe(404);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('NOT_FOUND');
      expect(body.error).toContain('Product');
      expect(body.error).toContain('12345');
    });

    it('should handle Arc ValidationError', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/validation-error', async () => {
          throw new ValidationError('Invalid input', [
            { field: 'name', message: 'Name is required' },
            { field: 'email', message: 'Invalid email format' },
          ]);
        });
      });

      const res = await app.inject({ method: 'GET', url: '/validation-error' });
      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.details.errors).toHaveLength(2);
    });

    it('should handle ForbiddenError', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/forbidden', async () => {
          throw new ForbiddenError('Not allowed');
        });
      });

      const res = await app.inject({ method: 'GET', url: '/forbidden' });
      expect(res.statusCode).toBe(403);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('FORBIDDEN');
    });

    it('should include requestId from ArcError', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/with-request-id', async () => {
          throw new ArcError('Oops', { statusCode: 500 }).withRequestId('req-abc-123');
        });
      });

      const res = await app.inject({ method: 'GET', url: '/with-request-id' });
      const body = JSON.parse(res.body);
      expect(body.requestId).toBe('req-abc-123');
    });
  });

  // ========================================================================
  // CastError → 400
  // ========================================================================

  describe('CastError (invalid ObjectId)', () => {
    it('should convert CastError to 400 INVALID_ID', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/cast-error', async () => {
          const err = new Error('Cast to ObjectId failed for value "abc"');
          err.name = 'CastError';
          throw err;
        });
      });

      const res = await app.inject({ method: 'GET', url: '/cast-error' });
      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_ID');
      expect(body.error).toBe('Invalid identifier format');
    });
  });

  // ========================================================================
  // Mongoose ValidationError → 400
  // ========================================================================

  describe('Mongoose ValidationError', () => {
    it('should convert Mongoose ValidationError to 400 with field details (dev mode)', async () => {
      await createApp({ includeStack: true }, (app) => {
        app.get('/mongoose-validation', async () => {
          const err = new Error('Validation failed') as any;
          err.name = 'ValidationError';
          err.errors = {
            name: { path: 'name', message: 'Name is required' },
            email: { path: 'email', message: 'Invalid email' },
          };
          throw err;
        });
      });

      const res = await app.inject({ method: 'GET', url: '/mongoose-validation' });
      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.details.errors).toHaveLength(2);
      expect(body.details.errors[0].field).toBe('name');
      expect(body.details.errors[1].field).toBe('email');
    });

    it('should hide field names in production mode', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/mongoose-validation-prod', async () => {
          const err = new Error('Validation failed') as any;
          err.name = 'ValidationError';
          err.errors = {
            name: { path: 'name', message: 'Name is required' },
            secret: { path: 'secret', message: 'Secret field error' },
          };
          throw err;
        });
      });

      const res = await app.inject({ method: 'GET', url: '/mongoose-validation-prod' });
      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.details.errorCount).toBe(2);
      expect(body.details.errors).toBeUndefined();
    });
  });

  // ========================================================================
  // Duplicate Key Error → 409
  // ========================================================================

  describe('MongoDB Duplicate Key Error (11000)', () => {
    it('should convert duplicate key to 409 with fields (dev mode)', async () => {
      await createApp({ includeStack: true }, (app) => {
        app.get('/duplicate', async () => {
          const err = new Error('E11000 duplicate key error') as any;
          err.name = 'MongoServerError';
          err.code = 11000;
          err.keyValue = { email: 'test@example.com' };
          throw err;
        });
      });

      const res = await app.inject({ method: 'GET', url: '/duplicate' });
      expect(res.statusCode).toBe(409);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('DUPLICATE_KEY');
      expect(body.error).toBe('Resource already exists');
      expect(body.details.duplicateFields).toEqual(['email']);
    });

    it('should hide duplicate fields in production mode', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/duplicate-prod', async () => {
          const err = new Error('E11000 duplicate key error') as any;
          err.name = 'MongoServerError';
          err.code = 11000;
          err.keyValue = { email: 'test@example.com' };
          throw err;
        });
      });

      const res = await app.inject({ method: 'GET', url: '/duplicate-prod' });
      expect(res.statusCode).toBe(409);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('DUPLICATE_KEY');
      expect(body.details).toBeUndefined();
    });
  });

  // ========================================================================
  // Fastify Validation Errors
  // ========================================================================

  describe('Fastify Schema Validation Errors', () => {
    it('should handle Fastify validation errors with field details', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.post('/validated', {
          schema: {
            body: {
              type: 'object',
              required: ['name', 'email'],
              properties: {
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
              },
            },
          },
        }, async (request) => {
          return { data: request.body };
        });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/validated',
        payload: {},
      });

      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toBe('Validation failed');
      expect(body.details.errors).toBeDefined();
      expect(body.details.errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ========================================================================
  // Fastify statusCode errors
  // ========================================================================

  describe('Fastify errors with statusCode', () => {
    it('should map Fastify statusCode errors to appropriate codes', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/fastify-error', async () => {
          const err = new Error('Not Found') as any;
          err.statusCode = 404;
          throw err;
        });
      });

      const res = await app.inject({ method: 'GET', url: '/fastify-error' });
      expect(res.statusCode).toBe(404);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('should handle 429 rate limit status', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/rate-limit', async () => {
          const err = new Error('Too many requests') as any;
          err.statusCode = 429;
          throw err;
        });
      });

      const res = await app.inject({ method: 'GET', url: '/rate-limit' });
      expect(res.statusCode).toBe(429);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('RATE_LIMITED');
    });
  });

  // ========================================================================
  // Custom errorMap
  // ========================================================================

  describe('Custom errorMap', () => {
    it('should use errorMap for custom error types', async () => {
      await createApp({
        includeStack: false,
        errorMap: {
          PaymentError: {
            statusCode: 402,
            code: 'PAYMENT_REQUIRED',
            message: 'Payment failed',
          },
        },
      }, (app) => {
        app.get('/payment-error', async () => {
          const err = new Error('Card declined');
          err.name = 'PaymentError';
          throw err;
        });
      });

      const res = await app.inject({ method: 'GET', url: '/payment-error' });
      expect(res.statusCode).toBe(402);

      const body = JSON.parse(res.body);
      expect(body.code).toBe('PAYMENT_REQUIRED');
      expect(body.error).toBe('Payment failed');
    });
  });

  // ========================================================================
  // Stack Trace Control
  // ========================================================================

  describe('Stack trace exposure', () => {
    it('should include stack when includeStack is true', async () => {
      await createApp({ includeStack: true }, (app) => {
        app.get('/error', async () => {
          throw new Error('Boom');
        });
      });

      const res = await app.inject({ method: 'GET', url: '/error' });
      const body = JSON.parse(res.body);
      expect(body.stack).toBeDefined();
      expect(body.stack).toContain('Error: Boom');
    });

    it('should NOT include stack when includeStack is false', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/error', async () => {
          throw new Error('Boom');
        });
      });

      const res = await app.inject({ method: 'GET', url: '/error' });
      const body = JSON.parse(res.body);
      expect(body.stack).toBeUndefined();
    });
  });

  // ========================================================================
  // onError Callback
  // ========================================================================

  describe('onError callback', () => {
    it('should call onError callback with error and request', async () => {
      const onError = vi.fn();

      await createApp({ onError, includeStack: false }, (app) => {
        app.get('/callback-error', async () => {
          throw new Error('Tracked error');
        });
      });

      await app.inject({ method: 'GET', url: '/callback-error' });

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Tracked error' }),
        expect.objectContaining({ url: '/callback-error' }),
      );
    });

    it('should not crash if onError callback throws', async () => {
      const onError = vi.fn(() => { throw new Error('Callback crash'); });

      await createApp({ onError, includeStack: false }, (app) => {
        app.get('/safe-callback', async () => {
          throw new Error('Original error');
        });
      });

      const res = await app.inject({ method: 'GET', url: '/safe-callback' });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Original error');
    });
  });

  // ========================================================================
  // Generic Error (500)
  // ========================================================================

  describe('Generic unhandled errors', () => {
    it('should return 500 INTERNAL_ERROR for unknown errors', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/unknown', async () => {
          throw new Error('Something unexpected');
        });
      });

      const res = await app.inject({ method: 'GET', url: '/unknown' });
      expect(res.statusCode).toBe(500);

      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.timestamp).toBeDefined();
    });
  });

  // ========================================================================
  // Response Envelope
  // ========================================================================

  describe('Response envelope consistency', () => {
    it('should always include success, error, code, and timestamp', async () => {
      await createApp({ includeStack: false }, (app) => {
        app.get('/envelope', async () => {
          throw new Error('Test');
        });
      });

      const res = await app.inject({ method: 'GET', url: '/envelope' });
      const body = JSON.parse(res.body);

      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code');
      expect(body).toHaveProperty('timestamp');
      expect(() => new Date(body.timestamp)).not.toThrow();
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });
  });
});
