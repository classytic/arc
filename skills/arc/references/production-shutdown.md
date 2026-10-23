# Production: graceful shutdown

Registered by default (`arcPlugins.gracefulShutdown`). Configure inline from `createApp`, or register `gracefulShutdownPlugin` from `@classytic/arc/plugins`.

```typescript
const app = await createApp({
  arcPlugins: {
    gracefulShutdown: {
      timeout: 30_000,          // hard cap; drainDelayMs counts against it
      drainDelayMs: 10_000,     // lame-duck window, default 0
      signals: ['SIGTERM', 'SIGINT'],
      logEvents: true,
      onShutdown: async () => {
        await mongoose.disconnect();
        await redis.quit();
      },
      onForceExit: (reason) => process.exit(1),   // reason: 'timeout' | 'error'; stub it in tests
    },
  },
});
```

## Sequence

1. Signal arrives: `fastify.shutdownState.draining = true`; `/_health/ready` returns 503 `draining`.
2. Wait `drainDelayMs`, still serving everything routed here. `/_health/live` stays 200.
3. `fastify.close()`: stop accepting, drain in-flight requests.
4. `onShutdown()`: release what arc does not own (DB connections, your Redis client).
5. Exit naturally; `onForceExit` fires if `timeout` elapses or a step throws.

## Rolling-deploy 502

With `drainDelayMs: 0` the instance closes the moment SIGTERM arrives, while the load balancer keeps routing to it until its readiness probe has failed for several intervals.

- Set `drainDelayMs` above the LB deregistration window, typically 5000 to 15000 ms.
- Kubernetes: keep `terminationGracePeriodSeconds` greater than `drainDelayMs + timeout`, or the kubelet SIGKILLs mid-drain.
- Liveness must not fail while draining: a 503 there gets the pod killed instead of drained.

## Gotchas

- `fastify.close()` runs before `onShutdown`: do not close anything an in-flight request still needs from `onShutdown`.
- Do not add `process.on('SIGTERM', () => app.close())`. The plugin owns the signals; a second handler closes immediately and skips the drain.
- Stores and clients you pass into arc are yours to close (in `onShutdown`).
