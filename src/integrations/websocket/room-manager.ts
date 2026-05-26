/**
 * RoomManager — subscription bookkeeping for the WebSocket plugin.
 *
 * Every connected client lives in zero or more "rooms" (resource channels,
 * arbitrary topic names). The manager indexes in both directions:
 *   - `rooms: room → Set<clientId>` for fan-out
 *   - `clients: clientId → WebSocketClient` for lookup + cleanup
 *
 * Local broadcast delivers to sockets on THIS instance; adapter-aware
 * variants also publish through the optional cross-instance adapter so
 * other instances fan out to their local sockets.
 */

/** Drop fan-out to a client whose outbound buffer exceeds this threshold. */
const WS_BACKPRESSURE_LIMIT = 256 * 1024; // 256 KB

import type { WebSocketAdapter } from "./adapter.js";
import type { PushRefRegistry } from "./pushref-registry.js";
import { type SafeAsyncLogger, safeAsync } from "./safe-async.js";
import type { WebSocketClient } from "./types.js";

export class RoomManager {
  private rooms = new Map<string, Set<string>>(); // room → clientIds
  private clients = new Map<string, WebSocketClient>(); // clientId → client
  /**
   * Secondary index: `pushRef → clientId`. A pushRef is stable across
   * reconnects (one per browser tab/device), where `clientId` is per-socket.
   * Lets the host send to a logical session ("this tab") without caring
   * which TCP connection currently backs it.
   */
  private clientIdByPushRef = new Map<string, string>();
  /**
   * Tertiary index: `userId → Set<clientId>`. Lets `sendToUser(userId, msg)`
   * fan out to every open tab/device for that user without scanning the
   * full client set.
   */
  private clientIdsByUserId = new Map<string, Set<string>>();
  private maxPerRoom: number;
  private adapter?: WebSocketAdapter;
  private registry?: PushRefRegistry;
  private logger: SafeAsyncLogger = {
    warn: () => {
      /* default no-op; plugin injects a real logger */
    },
  };

  constructor(
    maxPerRoom = 10000,
    adapter?: WebSocketAdapter,
    registry?: PushRefRegistry,
    logger?: SafeAsyncLogger,
  ) {
    this.maxPerRoom = maxPerRoom;
    this.adapter = adapter;
    this.registry = registry;
    if (logger) this.logger = logger;
  }

  addClient(client: WebSocketClient): void {
    this.clients.set(client.id, client);
    this.clientIdByPushRef.set(client.pushRef, client.id);
    if (client.userId) {
      const set = this.clientIdsByUserId.get(client.userId) ?? new Set();
      set.add(client.id);
      this.clientIdsByUserId.set(client.userId, set);
    }
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove from all rooms
    for (const room of client.subscriptions) {
      const members = this.rooms.get(room);
      if (members) {
        members.delete(clientId);
        if (members.size === 0) this.rooms.delete(room);
      }
    }

    // Stale-connection close guard: only clear the pushRef index if THIS
    // clientId still owns it. A reconnect race ([n8n websocket.push.ts:63]
    // pattern) can otherwise delete the *new* connection's entry.
    if (this.clientIdByPushRef.get(client.pushRef) === clientId) {
      this.clientIdByPushRef.delete(client.pushRef);
    }

    if (client.userId) {
      const set = this.clientIdsByUserId.get(client.userId);
      if (set) {
        set.delete(clientId);
        if (set.size === 0) this.clientIdsByUserId.delete(client.userId);
      }
    }

    client.subscriptions.clear();
    this.clients.delete(clientId);
  }

  /** Resolve a pushRef to its current backing client, if any. */
  getClientByPushRef(pushRef: string): WebSocketClient | undefined {
    const id = this.clientIdByPushRef.get(pushRef);
    return id ? this.clients.get(id) : undefined;
  }

  /** Snapshot of all clients currently owned by `userId`. */
  getClientsByUserId(userId: string): WebSocketClient[] {
    const ids = this.clientIdsByUserId.get(userId);
    if (!ids) return [];
    const out: WebSocketClient[] = [];
    for (const id of ids) {
      const c = this.clients.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  subscribe(clientId: string, room: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    // Check room capacity
    const members = this.rooms.get(room);
    if (members && members.size >= this.maxPerRoom) return false;

    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)?.add(clientId);
    client.subscriptions.add(room);
    return true;
  }

  unsubscribe(clientId: string, room: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const members = this.rooms.get(room);
    if (members) {
      members.delete(clientId);
      if (members.size === 0) this.rooms.delete(room);
    }
    client.subscriptions.delete(room);
  }

  broadcast(room: string, message: string, excludeClientId?: string): void {
    const members = this.rooms.get(room);
    if (!members) return;

    const dead: string[] = [];
    for (const clientId of members) {
      if (clientId === excludeClientId) continue;
      const client = this.clients.get(clientId);
      if (!client || client.socket.readyState !== 1) continue;
      // Skip slow readers whose outbound buffer is saturated; if the socket
      // never drains it will be caught by the heartbeat liveness check.
      if ((client.socket.bufferedAmount ?? 0) > WS_BACKPRESSURE_LIMIT) continue;
      try {
        client.socket.send(message);
      } catch {
        dead.push(clientId);
      }
    }
    for (const id of dead) this.removeClient(id);
  }

  /**
   * Droppable, coalesce-by-key broadcast to a room. Mirrors `broadcast()`
   * but routes through each client's `SendQueue.sendRealtime` so high-
   * frequency streams (GPS, cursors, presence) collapse to one queued
   * frame per recipient.
   *
   * Used by `GeoRoom.publish` for hyperlocal fan-out where the latest
   * snapshot is the only one that matters.
   */
  broadcastRealtime(room: string, message: string, coalesceKey: string): void {
    const members = this.rooms.get(room);
    if (!members) return;
    for (const clientId of members) {
      const client = this.clients.get(clientId);
      if (!client || client.socket.readyState !== 1) continue;
      // If the client has a queue, route through the coalescing path.
      // No queue ⇒ fall back to the bufferedAmount-skip broadcast — better
      // a dropped GPS frame than a memory leak.
      if (client.queue) {
        client.queue.sendRealtime(message, coalesceKey);
      } else if ((client.socket.bufferedAmount ?? 0) <= WS_BACKPRESSURE_LIMIT) {
        try {
          client.socket.send(message);
        } catch {
          /* dead socket — heartbeat will clean it up */
        }
      }
    }
  }

  broadcastToOrg(organizationId: string, room: string, message: string): void {
    const members = this.rooms.get(room);
    if (!members) return;

    const dead: string[] = [];
    for (const clientId of members) {
      const client = this.clients.get(clientId);
      if (!client || client.organizationId !== organizationId || client.socket.readyState !== 1)
        continue;
      if ((client.socket.bufferedAmount ?? 0) > WS_BACKPRESSURE_LIMIT) continue;
      try {
        client.socket.send(message);
      } catch {
        dead.push(clientId);
      }
    }
    for (const id of dead) this.removeClient(id);
  }

  /**
   * Broadcast locally AND through adapter (for cross-instance delivery).
   * Use this instead of broadcast() when multi-instance is possible.
   */
  async broadcastWithAdapter(
    room: string,
    message: string,
    excludeClientId?: string,
  ): Promise<void> {
    // Local delivery
    this.broadcast(room, message, excludeClientId);
    // Cross-instance delivery via adapter
    if (this.adapter) {
      await this.adapter.publish(room, message);
    }
  }

  /**
   * Org-scoped broadcast locally AND through adapter.
   * Uses a namespaced room key for the adapter so other instances
   * can filter by org when delivering locally.
   */
  async broadcastToOrgWithAdapter(
    organizationId: string,
    room: string,
    message: string,
  ): Promise<void> {
    // Local delivery (org-filtered)
    this.broadcastToOrg(organizationId, room, message);
    // Cross-instance delivery — use namespaced key so receiver can parse org + room
    if (this.adapter) {
      await this.adapter.publish(`org:${organizationId}:${room}`, message);
    }
  }

  /**
   * Addressed sends across instances. Wire format reuses the existing
   * room-prefix convention (`pushref:<id>`, `userid:<id>`) so the adapter
   * interface stays unchanged. Receiver-side plugin code dispatches on the
   * prefix and calls `sendToPushRef` / `sendToUser` locally.
   *
   * Critical guarantee (n8n shouldRelayViaPubSub pattern): the local call
   * is a no-op on every instance EXCEPT the one that owns the pushRef —
   * the address lookup itself is the ownership check.
   */
  async sendToPushRefWithAdapter(pushRef: string, message: string): Promise<void> {
    this.sendToPushRef(pushRef, message);
    if (this.adapter) {
      await this.adapter.publish(`pushref:${pushRef}`, message);
    }
  }

  async sendRealtimeToPushRefWithAdapter(
    pushRef: string,
    message: string,
    coalesceKey?: string,
  ): Promise<void> {
    this.sendRealtimeToPushRef(pushRef, message, coalesceKey);
    if (this.adapter) {
      // Coalesce key is local-only — different instances coalesce their own
      // queues independently. Carrying it cross-instance would require an
      // envelope change which we defer to PR 3.
      await this.adapter.publish(`pushref-rt:${pushRef}`, message);
    }
  }

  async sendToUserWithAdapter(userId: string, message: string): Promise<void> {
    this.sendToUser(userId, message);
    if (this.adapter) {
      await this.adapter.publish(`userid:${userId}`, message);
    }
  }

  async sendRealtimeToUserWithAdapter(
    userId: string,
    message: string,
    coalesceKey?: string,
  ): Promise<void> {
    this.sendRealtimeToUser(userId, message, coalesceKey);
    if (this.adapter) {
      await this.adapter.publish(`userid-rt:${userId}`, message);
    }
  }

  // ── Queue-aware addressed sends (PR 2) ────────────────────────────────
  //
  // These bypass the room fan-out and route to specific recipients via the
  // pushRef / userId indexes. Two delivery contracts:
  //
  //   - `sendTo*`         — ordered, important; overflow ⇒ socket terminate
  //   - `sendRealtimeTo*` — droppable, coalesce-by-key (GPS, presence, …)
  //
  // Both go through the per-connection `SendQueue` so backpressure,
  // overflow, and shed policy are uniform across call sites. If the
  // client has no queue (legacy host code that constructs a client by
  // hand), the methods fall through to raw `socket.send` with the same
  // bufferedAmount skip the broadcast paths use.

  /** Ordered send to a single pushRef. Returns true if delivered/queued. */
  sendToPushRef(pushRef: string, message: string): boolean {
    const c = this.getClientByPushRef(pushRef);
    return c ? this.deliver(c, message, "critical") : false;
  }

  /** Droppable send to a single pushRef. */
  sendRealtimeToPushRef(pushRef: string, message: string, coalesceKey?: string): boolean {
    const c = this.getClientByPushRef(pushRef);
    return c ? this.deliver(c, message, "droppable", coalesceKey) : false;
  }

  /**
   * Ordered fan-out to every open connection for `userId` (all tabs/devices).
   * Returns the count successfully queued.
   */
  sendToUser(userId: string, message: string): number {
    let n = 0;
    for (const c of this.getClientsByUserId(userId)) {
      if (this.deliver(c, message, "critical")) n++;
    }
    return n;
  }

  /** Droppable fan-out to every open connection for `userId`. */
  sendRealtimeToUser(userId: string, message: string, coalesceKey?: string): number {
    let n = 0;
    for (const c of this.getClientsByUserId(userId)) {
      if (this.deliver(c, message, "droppable", coalesceKey)) n++;
    }
    return n;
  }

  private deliver(
    client: WebSocketClient,
    message: string,
    cls: "critical" | "droppable",
    coalesceKey?: string,
  ): boolean {
    if (client.socket.readyState !== 1) return false;
    const queue = client.queue;
    if (queue) {
      if (cls === "critical") {
        if (client.envelope) {
          try {
            const parsed = JSON.parse(message) as unknown;
            queue.send(client.envelope.wrap(parsed));
            // Persist the updated envelope state out-of-band — the
            // deliver path stays synchronous; the network round-trip
            // happens behind safeAsync so a Redis outage surfaces as a
            // logged warning rather than an unhandled rejection.
            if (this.registry) {
              // Pass the connection's generation — the store's CAS write
              // refuses stale persists from a connection that was
              // superseded by a newer claim on another node (closes the
              // 2.17.2 review race where a fenced Node A's in-flight
              // persist could clobber Node B's claimed dead queue).
              safeAsync(
                this.registry.persist(client.pushRef, client.generation),
                this.logger,
                "registry.persist",
                { pushRef: client.pushRef, generation: client.generation },
              );
            }
          } catch {
            queue.send(message);
          }
        } else {
          queue.send(message);
        }
      } else {
        queue.sendRealtime(message, coalesceKey);
      }
      return true;
    }
    // Fallback: no queue wired — preserve the bufferedAmount skip from
    // the broadcast path so a legacy host doesn't lose backpressure.
    if ((client.socket.bufferedAmount ?? 0) > WS_BACKPRESSURE_LIMIT) return false;
    try {
      client.socket.send(message);
      return true;
    } catch {
      this.removeClient(client.id);
      return false;
    }
  }

  getClient(clientId: string): WebSocketClient | undefined {
    return this.clients.get(clientId);
  }

  getStats(): {
    clients: number;
    rooms: number;
    subscriptions: Record<string, number>;
  } {
    const subscriptions: Record<string, number> = {};
    for (const [room, members] of this.rooms) {
      subscriptions[room] = members.size;
    }
    return {
      clients: this.clients.size,
      rooms: this.rooms.size,
      subscriptions,
    };
  }
}
