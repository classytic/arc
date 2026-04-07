/**
 * Event Emission Tests
 *
 * Tests that CRUD operations emit events via fastify.events
 * when the event plugin is registered.
 *
 * This verifies the integration between arcCorePlugin and eventPlugin.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";

describe("Event Emission", () => {
  let app: any;
  let hookSystem: HookSystem;

  beforeEach(async () => {
    hookSystem = new HookSystem();
    app = Fastify({ logger: false });

    // Register event plugin first (provides fastify.events)
    await app.register(eventPlugin);

    // Register arc core with our hook system
    await app.register(arcCorePlugin, {
      hookSystem,
      emitEvents: true,
    });
  });

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  describe("CRUD event emission", () => {
    it("should emit resource.created event after create hooks", async () => {
      const events: any[] = [];
      await app.events.subscribe("product.created", async (event: any) => {
        events.push(event);
      });

      // Simulate afterCreate hook execution (as BaseController does)
      await hookSystem.executeAfter(
        "product",
        "create",
        {
          _id: "123",
          name: "Test Product",
        },
        {
          user: { id: "user-1", name: "Test User" },
          context: { _scope: { kind: "member", organizationId: "org-1", orgRoles: [] } },
        },
      );

      // Wait for async event processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("product.created");
      expect(events[0].payload.resource).toBe("product");
      expect(events[0].payload.operation).toBe("create");
      expect(events[0].payload.data._id).toBe("123");
      expect(events[0].payload.userId).toBe("user-1");
      expect(events[0].payload.organizationId).toBe("org-1");
    });

    it("should emit resource.updated event after update hooks", async () => {
      const events: any[] = [];
      await app.events.subscribe("order.updated", async (event: any) => {
        events.push(event);
      });

      await hookSystem.executeAfter(
        "order",
        "update",
        {
          _id: "456",
          status: "shipped",
        },
        {
          user: { _id: "user-2" },
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("order.updated");
      expect(events[0].payload.operation).toBe("update");
    });

    it("should emit resource.deleted event after delete hooks", async () => {
      const events: any[] = [];
      await app.events.subscribe("user.deleted", async (event: any) => {
        events.push(event);
      });

      await hookSystem.executeAfter("user", "delete", {
        _id: "789",
        email: "deleted@example.com",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("user.deleted");
      expect(events[0].payload.operation).toBe("delete");
    });

    it("should include timestamp in event payload", async () => {
      const events: any[] = [];
      // Use exact match pattern (MemoryEventTransport doesn't support *.created)
      await app.events.subscribe("item.created", async (event: any) => {
        events.push(event);
      });

      const before = new Date().toISOString();
      await hookSystem.executeAfter("item", "create", { _id: "1" });
      const after = new Date().toISOString();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events.length).toBe(1);
      expect(events[0].payload.timestamp).toBeDefined();
      expect(events[0].payload.timestamp >= before).toBe(true);
      expect(events[0].payload.timestamp <= after).toBe(true);
    });
  });

  describe("Event emission disabled", () => {
    it("should not emit events when emitEvents is false", async () => {
      const noEventApp = Fastify({ logger: false });
      const noEventHooks = new HookSystem();

      await noEventApp.register(eventPlugin);
      await noEventApp.register(arcCorePlugin, {
        hookSystem: noEventHooks,
        emitEvents: false,
      });

      const events: any[] = [];
      // Use '*' to catch all events (MemoryEventTransport supports this)
      await noEventApp.events.subscribe("*", async (event: any) => {
        events.push(event);
      });

      await noEventHooks.executeAfter("product", "create", { _id: "1" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No events should be emitted
      expect(events.length).toBe(0);

      await noEventApp.close();
    });
  });

  describe("Without event plugin", () => {
    it("should not fail when event plugin is not registered", async () => {
      const noEventPluginApp = Fastify({ logger: false });
      const hooks = new HookSystem();

      // Register arcCorePlugin WITHOUT eventPlugin
      await noEventPluginApp.register(arcCorePlugin, {
        hookSystem: hooks,
        emitEvents: true, // Events enabled but no plugin
      });

      // Should not throw when executing hooks
      await expect(
        hooks.executeAfter(
          "product",
          "create",
          { _id: "1" },
          {
            user: { id: "user-1" },
          },
        ),
      ).resolves.not.toThrow();

      await noEventPluginApp.close();
    });
  });

  describe("Event subscription patterns", () => {
    it("should support wildcard subscriptions for all events", async () => {
      const events: any[] = [];
      // Use '*' to catch all events (MemoryEventTransport supports this)
      await app.events.subscribe("*", async (event: any) => {
        events.push(event);
      });

      await hookSystem.executeAfter("product", "create", { _id: "1" });
      await hookSystem.executeAfter("order", "create", { _id: "2" });
      await hookSystem.executeAfter("user", "create", { _id: "3" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events.length).toBe(3);
      expect(events.map((e) => e.type)).toContain("product.created");
      expect(events.map((e) => e.type)).toContain("order.created");
      expect(events.map((e) => e.type)).toContain("user.created");
    });

    it("should support resource-specific subscriptions", async () => {
      const productEvents: any[] = [];
      const orderEvents: any[] = [];

      await app.events.subscribe("product.*", async (event: any) => {
        productEvents.push(event);
      });
      await app.events.subscribe("order.*", async (event: any) => {
        orderEvents.push(event);
      });

      await hookSystem.executeAfter("product", "create", { _id: "1" });
      await hookSystem.executeAfter("product", "update", { _id: "1" });
      await hookSystem.executeAfter("order", "create", { _id: "2" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(productEvents.length).toBe(2);
      expect(orderEvents.length).toBe(1);
    });
  });
});
