# Arc Factory - Production-Ready Application Creation

The Arc Factory pattern provides a secure, production-ready way to create Fastify applications with sensible defaults and **opt-out security**.

## Philosophy

> **Security by default, not by choice.**

Traditional Fastify setup requires developers to remember every security plugin:
```javascript
// ❌ Easy to forget something critical
const fastify = Fastify();
await fastify.register(helmet);   // Did I configure CSP correctly?
await fastify.register(cors);     // Did I whitelist origins?
await fastify.register(rateLimit); // Oops, forgot this!
// ... forgot under-pressure, etc.
```

Arc Factory makes security plugins **opt-out instead of opt-in**:
```javascript
// ✅ Secure by default
const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: ['https://example.com'] }, // Only override what you need
  // helmet, rateLimit, underPressure all enabled automatically!
});
```

---

## Quick Start

### Installation

```bash
npm install @classytic/arc
```

### Basic Usage

```javascript
import { createApp } from '@classytic/arc/factory';
import mongoose from 'mongoose';

// 1. Connect your database separately (Arc is database-agnostic)
await mongoose.connect(process.env.MONGO_URI);

// 2. Create Arc app
const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: [process.env.FRONTEND_URL] },
});

await app.listen({ port: 3000, host: '0.0.0.0' });
```

---

## Presets

Arc provides three environment presets with sensible defaults:

### Production Preset

**Strict security, performance optimized**

```javascript
const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: ['https://example.com'] }, // Must explicitly configure
});
```

**Enabled by default:**
- ✅ Helmet (security headers with CSP)
- ✅ CORS (disabled by default - must configure)
- ✅ Rate limiting (100 req/min)
- ✅ Health monitoring (under-pressure)
- ✅ Structured logging (pino)

> **Note**: Compression is not included due to known Fastify 5 stream issues. Use a reverse proxy (Nginx, Caddy) or CDN for response compression.

### Development Preset

**Relaxed security, verbose logging**

```javascript
const app = await createApp({
  preset: 'development',
  auth: { jwt: { secret: 'dev-secret-32-chars-minimum-length' } },
});
```

**Differences from production:**
- ✅ CORS allows all origins
- ✅ CSP disabled (easier debugging)
- ✅ Rate limiting very relaxed (1000 req/min)
- ✅ Colorized, pretty-printed logs

### Testing Preset

**Minimal setup, fast startup**

```javascript
const app = await createApp({
  preset: 'testing',
  auth: { jwt: { secret: 'test-secret-32-chars-minimum-len' } },
});
```

**Minimal configuration:**
- ✅ Logging disabled
- ✅ Security plugins disabled (faster tests)
- ✅ Core utilities still enabled (sensible, multipart)

---

## Factory Shortcuts

For common scenarios, use the `ArcFactory` helper:

```javascript
import { ArcFactory } from '@classytic/arc/factory';

// Production
const app = await ArcFactory.production({
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: [process.env.FRONTEND_URL] },
});

// Development
const app = await ArcFactory.development({
  auth: { jwt: { secret: 'dev-secret-32-chars-minimum-length' } },
});

// Testing
const app = await ArcFactory.testing({
  auth: { jwt: { secret: 'test-secret-32-chars-minimum-len' } },
});
```

---

## Configuration Options

### Auth Configuration

```typescript
interface CreateAppOptions {
  // Required when using Arc auth (32+ characters recommended)
  auth?: {
    jwt: { secret: string; expiresIn?: string };  // JWT configuration
    authenticate?: (request, helpers) => User | null;  // Custom authenticator
  } | false;  // Set to false to disable auth

  // Optional
  preset?: 'production' | 'development' | 'testing';
}
```

> **Note**: Arc is database-agnostic. Connect your database separately before creating the app.

### Security Plugins (opt-out)

All security plugins are **enabled by default**. Set to `false` to disable.

```javascript
const app = await createApp({
  // ... required options

  // Helmet - Security headers
  helmet: {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  },
  // Or disable: helmet: false

  // CORS - Cross-origin requests
  cors: {
    origin: ['https://example.com', 'https://admin.example.com'],
    credentials: true,
  },
  // Or disable: cors: false

  // Rate limiting - DDoS protection
  rateLimit: {
    max: 100,
    timeWindow: '1 minute',
  },
  // Or disable: rateLimit: false
});
```

### Performance Plugins (opt-out)

```javascript
const app = await createApp({
  // ... required options

  // Under Pressure - Health monitoring
  underPressure: {
    exposeStatusRoute: true,            // GET /status
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 1024 * 1024 * 1024, // 1GB
  },
  // Or disable: underPressure: false
});
```

> **Note**: Compression is not included due to known Fastify 5 stream issues ([#6017](https://github.com/fastify/fastify/issues/6017)). Use a reverse proxy (Nginx, Caddy) or CDN for response compression.

### Utility Plugins

```javascript
const app = await createApp({
  // ... required options

  // Sensible - HTTP helpers
  sensible: true,  // fastify.httpErrors.notFound(), etc.

  // Multipart - File uploads
  multipart: {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB
      files: 10,
    },
  },
  // Or disable: multipart: false

  // Raw body - For webhooks (Stripe, etc.)
  rawBody: {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
  },
  // Or disable: rawBody: false
});
```

### Arc Plugins

```javascript
const app = await createApp({
  // ... required options

  arcPlugins: {
    requestId: true,         // Add X-Request-Id to all requests
    health: true,            // GET /health endpoint
    gracefulShutdown: true,  // Handle SIGTERM/SIGINT
  },
});
```

### Custom Plugins

```javascript
const app = await createApp({
  // ... required options

  plugins: async (fastify) => {
    // Register your custom plugins here
    await fastify.register(yourCustomPlugin);
    await fastify.register(anotherPlugin, { options });
  },
});
```

---

## Complete Example

### Production Setup

```javascript
// index.js
import { createApp } from '@classytic/arc/factory';
import mongoose from 'mongoose';
import closeWithGrace from 'close-with-grace';
import myRoutes from './routes/index.js';

// Connect database first (Arc is database-agnostic)
await mongoose.connect(process.env.MONGO_URI);

const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },

  // Security
  cors: {
    origin: [
      process.env.FRONTEND_URL,
      process.env.ADMIN_URL,
    ],
    credentials: true,
  },
  rateLimit: {
    max: 100,
    timeWindow: '1 minute',
  },

  // Custom plugins
  plugins: async (fastify) => {
    await fastify.register(myRoutes, { prefix: '/api/v1' });
  },
});

// Graceful shutdown
closeWithGrace({ delay: 10000 }, async ({ signal, err }) => {
  if (err) app.log.error('Shutdown triggered by error', err);
  else app.log.info(`Received ${signal}, shutting down`);
  await app.close();
  await mongoose.connection.close();
});

// Start
await app.listen({ port: 3000, host: '0.0.0.0' });
app.log.info('Server started at http://localhost:3000');
```

### Development Setup

```javascript
// index.js
import { ArcFactory } from '@classytic/arc/factory';
import mongoose from 'mongoose';
import myRoutes from './routes/index.js';

await mongoose.connect('mongodb://localhost:27017/myapp_dev');

const app = await ArcFactory.development({
  auth: { jwt: { secret: 'dev-secret-change-in-production-32chars' } },

  plugins: async (fastify) => {
    await fastify.register(myRoutes, { prefix: '/api/v1' });
  },
});

await app.listen({ port: 3000, host: '0.0.0.0' });
console.log('Dev server at http://localhost:3000');
```

### Testing Setup

```javascript
// test/helpers/create-test-app.js
import { ArcFactory } from '@classytic/arc/factory';
import myRoutes from '../../routes/index.js';

export async function createTestApp() {
  const app = await ArcFactory.testing({
    auth: { jwt: { secret: 'test-secret-32-chars-minimum-len' } },

    plugins: async (fastify) => {
      await fastify.register(myRoutes, { prefix: '/api/v1' });
    },
  });

  return app;
}

// test/example.test.js
import { createTestApp } from './helpers/create-test-app.js';

describe('API Tests', () => {
  let app;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  test('GET /health', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
  });
});
```

---

## Comparison: Before vs After

### Before (Manual Setup)

```javascript
// ❌ 80+ lines of boilerplate, easy to forget plugins
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import rawBody from 'fastify-raw-body';
// ... more imports

const fastify = Fastify({ logger: true, trustProxy: true });

await fastify.register(helmet, {
  contentSecurityPolicy: { /* ... */ },
});

await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN?.split(',') || false,
  credentials: true,
  // ... more options
});

await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

// ... 40 more lines of plugin registration
```

### After (Factory Pattern)

```javascript
// ✅ 10 lines, secure by default
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: [process.env.FRONTEND_URL] },
});

// All security plugins enabled automatically!
```

**Result**: **80% less boilerplate**, **impossible to forget security plugins**

---

## Migration Guide

### From Manual Setup to Factory

```javascript
// BEFORE
const fastify = Fastify({ logger: true, trustProxy: true });
await fastify.register(registerCorePlugins);
await fastify.register(myRoutes, { prefix: '/api/v1' });

// AFTER
const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  plugins: async (fastify) => {
    await fastify.register(myRoutes, { prefix: '/api/v1' });
  },
});
```

### Gradual Migration

You don't have to migrate all at once:

```javascript
// Step 1: Keep existing setup, add factory for new services
import { createApp } from '@classytic/arc/factory';

// New service using factory
const newService = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
});

// Step 2: Migrate routes one by one
// Step 3: Remove old manual setup when done
```

---

## Best Practices

### 1. Always Use Presets in Production

```javascript
// ✅ Good
const app = await createApp({
  preset: 'production',
  // ...
});

// ❌ Bad - missing security defaults
const app = await createApp({
  auth: { jwt: { secret: '...' } },
  // No preset = no defaults!
});
```

### 2. Explicitly Configure CORS in Production

```javascript
// ✅ Good - whitelist specific origins
const app = await createApp({
  preset: 'production',
  cors: {
    origin: [
      'https://example.com',
      'https://admin.example.com',
    ],
  },
});

// ❌ Bad - allows all origins
const app = await createApp({
  preset: 'production',
  cors: { origin: true }, // ❌ Insecure!
});
```

### 3. Disable Plugins Explicitly

```javascript
// ✅ Good - explicit opt-out
const app = await createApp({
  preset: 'testing',
  helmet: false,      // Explicitly disabled for tests
  rateLimit: false,   // Clear intent
});

// ❌ Bad - unclear if intentional
const app = await createApp({
  preset: 'production',
  // Did I forget helmet? Or disabled intentionally?
});
```

### 4. Use Environment Variables

```javascript
// ✅ Good - configuration from environment
const app = await createApp({
  preset: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  cors: {
    origin: process.env.CORS_ORIGINS?.split(',') || [],
  },
});
```

---

## Troubleshooting

### "Failed to load plugin 'xyz'"

Some plugins are optional dependencies. Install them if needed:

```bash
npm install @fastify/helmet @fastify/cors @fastify/rate-limit @fastify/under-pressure
```

### "JWT secret required when Arc auth is enabled"

The factory requires `auth.jwt.secret` when using Arc's built-in auth:

```javascript
// If you don't need auth, disable it
const app = await createApp({
  auth: false,
  // ...
});

// Or provide a secret if using auth
const app = await createApp({
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  // ...
});
```

### Logs show "⚠️ Plugin disabled"

This is expected when explicitly disabling plugins:

```javascript
const app = await createApp({
  helmet: false, // Logs: "⚠️ Helmet disabled"
});
```

To suppress warnings, use the testing preset which expects minimal setup.

---

## API Reference

See [TypeScript definitions](../src/factory/types.ts) for complete API documentation.

---

## Related Documentation

- [Core API](./core.md) - BaseController, createCrudRouter, defineResource
- [Authentication](./auth.md) - JWT, permissions, role-based access
- [Presets](./presets.md) - Reusable resource configurations
- [Production Deployment](./deployment.md) - Docker, Kubernetes, scaling

---

**Status**: ✅ Stable
**Since**: Arc v2.0.0
**Philosophy**: Security by default, not by choice
