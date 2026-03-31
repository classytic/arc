/**
 * Ambient module declarations for optional peer dependencies.
 *
 * These tell TypeScript that these modules MAY exist at runtime
 * (installed by the user) without requiring them in devDependencies.
 * Actual types come from the packages themselves when installed.
 */

declare module "@modelcontextprotocol/sdk/server/mcp.js" {
  export class McpServer {
    constructor(info: { name: string; version: string }, options?: Record<string, unknown>);
    tool(...args: unknown[]): void;
    prompt(...args: unknown[]): void;
    resource(...args: unknown[]): void;
    connect(transport: unknown): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/server/streamableHttp.js" {
  export class StreamableHTTPServerTransport {
    sessionId: string;
    constructor(options?: Record<string, unknown>);
    handleRequest(req: unknown, res: unknown, body?: unknown): Promise<void>;
    close(): void;
  }
}

declare module "bullmq" {
  export class Queue {
    constructor(name: string, opts?: Record<string, unknown>);
    add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<{ id: string }>;
    getJobCounts(): Promise<Record<string, number>>;
    close(): Promise<void>;
  }

  export class Worker {
    constructor(
      name: string,
      processor: (job: any) => Promise<unknown>,
      opts?: Record<string, unknown>,
    );
    on(event: string, handler: (...args: any[]) => void): void;
    close(): Promise<void>;
  }
}
