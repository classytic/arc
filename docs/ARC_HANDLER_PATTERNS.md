# Arc Handler Patterns Guide

Arc supports two patterns for writing route handlers. Choose based on your needs.

## Pattern 1: Arc Context Pattern (Recommended for most cases)

**Use when**: Standard CRUD operations, business logic, most API endpoints

**Signature**: `async methodName(req: IRequestContext): Promise<IControllerResponse>`

**Benefits**:
- ✅ Framework-agnostic (can switch from Fastify to Express)
- ✅ Clean, predictable API
- ✅ Built-in field masking, security features
- ✅ Easier to test (mock plain objects)

### Example: Standard API Endpoint

```typescript
import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

class ProductController extends BaseController {
  async getByCategory(req: IRequestContext): Promise<IControllerResponse> {
    const { category } = req.params;
    const { limit = 10 } = req.query;

    const products = await this.repository.getAll({
      filters: { category },
      limit: Number(limit),
    });

    return {
      success: true,
      data: products,
      status: 200,
    };
  }
}

// Resource definition
defineResource({
  name: 'product',
  controller: new ProductController(productRepository),
  additionalRoutes: [
    {
      method: 'GET',
      path: '/category/:category',
      handler: 'getByCategory',
      wrapHandler: true,  // ✅ Arc wraps this
      permissions: allowPublic(),
    },
  ],
});
```

### Available Fields in `req: IRequestContext`

```typescript
{
  params: Record<string, string>;        // Route params: /users/:id
  query: Record<string, unknown>;        // Query string: ?page=1&limit=10
  body: unknown;                         // Request body (POST/PATCH/PUT)
  user: UserBase | null;                 // Authenticated user (or null)
  headers: Record<string, string | undefined>;  // Request headers
  organizationId?: string;               // Tenant/org ID (multi-tenant apps)
  metadata?: Record<string, unknown>;    // Custom data, hooks, policy filters
}
```

### Available Fields in Response

```typescript
{
  success: boolean;                      // true/false
  data?: T;                              // Response payload
  error?: string;                        // Error message
  status?: number;                       // HTTP status (default: 200/400)
  meta?: Record<string, unknown>;        // Pagination, counts, etc.
  details?: Record<string, unknown>;     // Debug info
}
```

---

## Pattern 2: Native Fastify Pattern (For special cases)

**Use when**:
- File downloads/uploads
- Streaming responses
- Custom headers (Content-Type, Cache-Control, etc.)
- Redirects
- Raw responses (HTML, XML, binary)
- WebSocket upgrades

**Signature**: `async methodName(request: FastifyRequest, reply: FastifyReply): Promise<void>`

**Benefits**:
- ✅ Full control over response
- ✅ Direct access to Fastify features
- ✅ Streaming support
- ✅ Custom content types

### Example 1: File Download with Custom Headers

```typescript
import type { FastifyRequest, FastifyReply } from 'fastify';
import { defineResource } from '@classytic/arc';
import fs from 'fs/promises';

class ReportController {
  async downloadPDF(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.params as { id: string };

    // Get file from storage
    const report = await reportRepository.getById(id);
    const fileBuffer = await fs.readFile(report.filePath);

    // Set custom headers
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${report.filename}"`);
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');

    // Send file
    return reply.send(fileBuffer);
  }
}

// Resource definition
defineResource({
  name: 'report',
  controller: new ReportController(),
  additionalRoutes: [
    {
      method: 'GET',
      path: '/:id/download',
      handler: 'downloadPDF',
      wrapHandler: false,  // ✅ Native Fastify handler
      permissions: requireAuthenticated(),
    },
  ],
});
```

### Example 2: Streaming Large Files

```typescript
import { createReadStream } from 'fs';

class VideoController {
  async streamVideo(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.params as { id: string };

    const video = await videoRepository.getById(id);
    const stream = createReadStream(video.filePath);

    reply.header('Content-Type', 'video/mp4');
    reply.header('Accept-Ranges', 'bytes');

    return reply.send(stream);
  }
}

// wrapHandler: false for streaming
```

### Example 3: Custom Content-Type (CSV Export)

```typescript
class ExportController {
  async exportCSV(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { organizationId } = request as any; // From org scope plugin

    const employees = await employeeRepository.getAll({
      filters: { organizationId },
    });

    // Convert to CSV
    const csv = convertToCSV(employees.docs);

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="employees.csv"');

    return reply.send(csv);
  }
}

// wrapHandler: false for custom content type
```

### Example 4: Redirect

```typescript
class AuthController {
  async oauthCallback(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { code } = request.query as { code: string };

    // Exchange code for token
    const token = await oauthService.exchangeCode(code);

    // Redirect to dashboard with token
    return reply.redirect(302, `/dashboard?token=${token}`);
  }
}

// wrapHandler: false for redirects
```

### Example 5: Server-Sent Events (SSE)

```typescript
class NotificationController {
  async subscribe(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = (request as any).user;

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    // Set up SSE stream
    const interval = setInterval(() => {
      reply.raw.write(`data: ${JSON.stringify({ time: Date.now() })}\n\n`);
    }, 1000);

    request.raw.on('close', () => {
      clearInterval(interval);
    });
  }
}

// wrapHandler: false for SSE
```

---

## Quick Decision Guide

| Use Case | Pattern | wrapHandler |
|----------|---------|-------------|
| Standard GET/POST/PATCH/DELETE | Arc Context | `true` |
| Business logic | Arc Context | `true` |
| JSON responses | Arc Context | `true` |
| File download | Native Fastify | `false` |
| File upload | Native Fastify | `false` |
| Streaming | Native Fastify | `false` |
| Custom headers | Native Fastify | `false` |
| Redirect | Native Fastify | `false` |
| SSE/WebSocket | Native Fastify | `false` |
| Custom content-type (CSV, XML, etc.) | Native Fastify | `false` |

---

## Common Mistakes

### ❌ Mistake 1: Wrong wrapHandler value

```typescript
// Controller method returns IControllerResponse
async getConfig(req: IRequestContext): Promise<IControllerResponse> {
  return { success: true, data: config };
}

// But resource says wrapHandler: false
additionalRoutes: [{
  handler: 'getConfig',
  wrapHandler: false,  // ❌ WRONG! Should be true
}]
```

### ✅ Fix: Match wrapHandler to method signature

```typescript
// IRequestContext → wrapHandler: true
async getConfig(req: IRequestContext): Promise<IControllerResponse> { ... }
additionalRoutes: [{ handler: 'getConfig', wrapHandler: true }]

// Fastify native → wrapHandler: false
async downloadFile(req: FastifyRequest, reply: FastifyReply): Promise<void> { ... }
additionalRoutes: [{ handler: 'downloadFile', wrapHandler: false }]
```

---

## Accessing Fastify Features in Arc Context Pattern

**Q: What if I need to set a custom header but still want Arc's abstraction?**

**A**: You have two options:

### Option 1: Return header in metadata (if Arc supports it)

```typescript
async getConfig(req: IRequestContext): Promise<IControllerResponse> {
  return {
    success: true,
    data: config,
    meta: {
      headers: {
        'Cache-Control': 'max-age=3600',
      },
    },
  };
}
```

*Note: Check if Arc's `createFastifyHandler` supports this - it may not currently!*

### Option 2: Switch to Native Fastify pattern

```typescript
async getConfig(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const config = await configRepo.getConfig();

  reply.header('Cache-Control', 'max-age=3600');
  return reply.send({
    success: true,
    data: config,
  });
}

// wrapHandler: false
```

---

## Testing

### Testing Arc Context Handlers

```typescript
import { describe, it, expect } from 'vitest';

describe('ProductController', () => {
  it('should get products by category', async () => {
    const controller = new ProductController(mockRepository);

    // Easy to test - just pass a plain object
    const result = await controller.getByCategory({
      params: { category: 'electronics' },
      query: { limit: '5' },
      body: null,
      user: null,
      headers: {},
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(5);
  });
});
```

### Testing Native Fastify Handlers

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('ReportController', () => {
  it('should download PDF with correct headers', async () => {
    const controller = new ReportController();

    const mockRequest = {
      params: { id: '123' },
    } as FastifyRequest;

    const mockReply = {
      header: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as any;

    await controller.downloadPDF(mockRequest, mockReply);

    expect(mockReply.header).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(mockReply.send).toHaveBeenCalled();
  });
});
```

---

## Summary

- **Default to Arc Context Pattern** (`wrapHandler: true`) for 90% of your routes
- **Use Native Fastify Pattern** (`wrapHandler: false`) only when you need:
  - File downloads/uploads
  - Streaming
  - Custom headers
  - Redirects
  - Non-JSON responses

Both patterns work great - just pick the right one for your use case! 🚀
