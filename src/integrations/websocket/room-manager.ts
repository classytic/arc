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

import type { WebSocketAdapter } from "./adapter.js";
import type { WebSocketClient } from "./types.js";

export class RoomManager {
  private rooms = new Map<string, Set<string>>(); // room → clientIds
  private clients = new Map<string, WebSocketClient>(); // clientId → client
  private maxPerRoom: number;
  private adapter?: WebSocketAdapter;

  constructor(maxPerRoom = 10000, adapter?: WebSocketAdapter) {
    this.maxPerRoom = maxPerRoom;
    this.adapter = adapter;
  }

  addClient(client: WebSocketClient): void {
    this.clients.set(client.id, client);
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

    client.subscriptions.clear();
    this.clients.delete(clientId);
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

    for (const clientId of members) {
      if (clientId === excludeClientId) continue;
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === 1) {
        try {
          client.socket.send(message);
        } catch {
          // Client disconnected, will be cleaned up
        }
      }
    }
  }

  broadcastToOrg(organizationId: string, room: string, message: string): void {
    const members = this.rooms.get(room);
    if (!members) return;

    for (const clientId of members) {
      const client = this.clients.get(clientId);
      if (client && client.organizationId === organizationId && client.socket.readyState === 1) {
        try {
          client.socket.send(message);
        } catch {
          // Client disconnected
        }
      }
    }
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
