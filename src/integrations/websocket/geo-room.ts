/**
 * Geo-room — spatial subscription manager.
 *
 * The pattern Uber / Lyft / Grab use for "drivers near rider" feeds:
 * tile the world into hexagonal cells (H3) and use each cell as a room.
 * A publisher fans out to its own cell + its k-ring neighbors; a
 * subscriber listens to its own cell + neighbors. The intersection is
 * the "drivers within ~radius" set, computed entirely server-side with
 * no per-message radius math.
 *
 * Why H3 specifically:
 *   - Hexagonal cells have uniform neighbor distances (squares don't —
 *     diagonal vs cardinal neighbors are √2× apart, which warps radius).
 *   - kRing(center, n) is O(n²) but with tiny constants — sub-microsecond
 *     for n ≤ 5.
 *   - Resolution 9 ≈ 0.1 km edge (good for ride-hailing); resolution 10
 *     ≈ 0.04 km (food delivery courier tracking).
 *
 * `h3-js` is declared as an **optional peer dependency**. Importing it
 * lazily means hosts that don't need geo-rooms never pull the WASM
 * runtime — the file is loaded the first time `GeoRoom` is constructed.
 *
 * Public API:
 *   - `geoRoom.publish(scope, payload, opts)` — fan-out a message to a
 *     point's cell + neighbors. Droppable + coalesceable by default
 *     (location updates are sendRealtime-class).
 *   - `geoRoom.subscribe(scope, point, opts)` — subscribe a client to
 *     every cell inside `radius` of `point`. Returns the kRing diameter
 *     used (helpful for debugging).
 *   - `geoRoom.unsubscribe(scope, point, opts)` — symmetric.
 */

import type { RoomManager } from "./room-manager.js";

type H3Lib = {
  latLngToCell(lat: number, lng: number, res: number): string;
  gridDisk(cell: string, k: number): string[];
};

let h3Cached: H3Lib | undefined;

async function loadH3(): Promise<H3Lib> {
  if (h3Cached) return h3Cached;
  try {
    // Lazy ESM import — only resolved if the host actually uses geo-rooms.
    const mod = (await import("h3-js")) as Partial<H3Lib> & { default?: Partial<H3Lib> };
    const merged = { ...(mod.default ?? {}), ...mod } as Partial<H3Lib>;
    if (typeof merged.latLngToCell !== "function" || typeof merged.gridDisk !== "function") {
      throw new Error("h3-js missing latLngToCell / gridDisk exports");
    }
    h3Cached = merged as H3Lib;
    return h3Cached;
  } catch {
    throw new Error(
      "[arc-websocket] geo-room support requires h3-js.\n" + "Install it: npm install h3-js",
    );
  }
}

export interface GeoRoomOptions {
  /** H3 resolution. 9 ≈ 100 m edge (ride-hailing default); 10 ≈ 40 m. */
  resolution?: number;
  /**
   * Room-key prefix so geo-rooms don't collide with arbitrary topic names.
   * Defaults to `geo:`. Resulting room: `geo:<h3cell>`.
   */
  prefix?: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeoPublishOpts {
  /** k-ring radius — `0` = just the cell, `1` = cell + 6 neighbors, etc. */
  ring?: number;
  /**
   * Coalesce key for queue-side keep-latest-snapshot. Defaults to the
   * client's pushRef so a driver streaming 5 Hz GPS collapses to one
   * queued frame per recipient.
   */
  coalesceKey?: string;
  /**
   * Delivery class. `'droppable'` (default) routes through `sendRealtime`
   * — correct for high-frequency location streams. `'critical'` routes
   * through `send` — use sparingly for dispatch events like "ride accepted".
   */
  delivery?: "droppable" | "critical";
}

/**
 * A geo-aware subscription layer on top of `RoomManager`. Construct one
 * per logical channel (e.g. one for `drivers`, one for `couriers`) so
 * resolutions and prefixes don't cross-contaminate.
 */
export class GeoRoom {
  private rooms: RoomManager;
  private resolution: number;
  private prefix: string;
  private h3?: H3Lib;

  constructor(rooms: RoomManager, opts: GeoRoomOptions = {}) {
    this.rooms = rooms;
    this.resolution = opts.resolution ?? 9;
    this.prefix = opts.prefix ?? "geo:";
  }

  /** Subscribe a client to every cell within `ring` of `point`. */
  async subscribe(
    clientId: string,
    point: GeoPoint,
    opts: { ring?: number } = {},
  ): Promise<string[]> {
    const h3 = await this.h3lib();
    const ring = opts.ring ?? 1;
    const center = h3.latLngToCell(point.lat, point.lng, this.resolution);
    const cells = h3.gridDisk(center, ring);
    const rooms: string[] = [];
    for (const cell of cells) {
      const room = `${this.prefix}${cell}`;
      if (this.rooms.subscribe(clientId, room)) rooms.push(room);
    }
    return rooms;
  }

  /** Symmetric — unsubscribe from every cell within `ring`. */
  async unsubscribe(
    clientId: string,
    point: GeoPoint,
    opts: { ring?: number } = {},
  ): Promise<void> {
    const h3 = await this.h3lib();
    const ring = opts.ring ?? 1;
    const center = h3.latLngToCell(point.lat, point.lng, this.resolution);
    const cells = h3.gridDisk(center, ring);
    for (const cell of cells) {
      this.rooms.unsubscribe(clientId, `${this.prefix}${cell}`);
    }
  }

  /**
   * Publish to every client subscribed to a cell within `ring` of `point`.
   * Droppable by default — every recipient queue keeps only the latest
   * per `coalesceKey` (defaults to the publisher's pushRef).
   */
  async publish(
    publisher: { pushRef: string },
    point: GeoPoint,
    payload: string,
    opts: GeoPublishOpts = {},
  ): Promise<void> {
    const h3 = await this.h3lib();
    const ring = opts.ring ?? 1;
    const center = h3.latLngToCell(point.lat, point.lng, this.resolution);
    const cells = h3.gridDisk(center, ring);
    const coalesceKey = opts.coalesceKey ?? publisher.pushRef;
    const delivery = opts.delivery ?? "droppable";
    for (const cell of cells) {
      const room = `${this.prefix}${cell}`;
      if (delivery === "critical") {
        // Critical broadcast keeps ordering and bypasses coalesce —
        // every queue takes a full copy.
        this.rooms.broadcast(room, payload);
      } else {
        // Droppable: queue-coalesced fan-out so high-frequency GPS
        // streams collapse to one queued frame per recipient.
        this.rooms.broadcastRealtime(room, payload, coalesceKey);
      }
    }
  }

  /** Compute the cell ID for a point without subscribing — useful for tests. */
  async cellFor(point: GeoPoint): Promise<string> {
    const h3 = await this.h3lib();
    return h3.latLngToCell(point.lat, point.lng, this.resolution);
  }

  private async h3lib(): Promise<H3Lib> {
    if (!this.h3) this.h3 = await loadH3();
    return this.h3;
  }
}
