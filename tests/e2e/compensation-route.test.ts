/**
 * Compensation + Arc Full Stack E2E
 *
 * Proves withCompensation works inside a real Arc app with:
 * - createApp with JWT auth
 * - defineResource with additionalRoute
 * - Permission enforcement (401 without token, 200 with)
 * - Compensation rollback on step failure
 * - Proper Arc response envelope
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose, { Schema, type Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';

interface IOrder {
  _id: Types.ObjectId;
  items: string[];
  total: number;
  status: string;
}

let mongoServer: MongoMemoryServer;
let connection: mongoose.Connection;
let OrderModel: mongoose.Model<IOrder>;
let app: FastifyInstance;

describe('Compensation in Arc additionalRoute', () => {
  beforeAll(async () => {
    // Isolated DB connection
    mongoServer = await MongoMemoryServer.create();
    connection = mongoose.createConnection(mongoServer.getUri('comp-e2e'));
    await connection.asPromise();

    OrderModel = connection.model<IOrder>(
      'CompOrder',
      new Schema<IOrder>({
        items: [String],
        total: Number,
        status: { type: String, default: 'pending' },
      }),
    );

    // Build Arc app
    const { createApp } = await import('../../src/factory/createApp.js');
    const { defineResource, createMongooseAdapter } = await import('../../src/index.js');
    const { allowPublic, requireAuth } = await import('../../src/permissions/index.js');
    const { withCompensation } = await import('../../src/utils/compensation.js');
    const { Repository } = await import('@classytic/mongokit');

    const repo = new Repository(OrderModel);

    const orderResource = defineResource({
      name: 'order',
      adapter: createMongooseAdapter({ model: OrderModel, repository: repo }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
      additionalRoutes: [
        {
          method: 'POST',
          path: '/:id/checkout',
          summary: 'Process order checkout with compensation',
          permissions: requireAuth(),
          wrapHandler: false,
          handler: async (request, reply) => {
            const { id } = request.params as { id: string };
            const order = await OrderModel.findById(id).lean();
            if (!order) {
              return reply.code(404).send({ success: false, error: 'Order not found' });
            }

            const result = await withCompensation('checkout', [
              {
                name: 'validate',
                execute: async (ctx) => {
                  if (order.items.length === 0) throw new Error('Empty cart');
                  ctx.orderId = id;
                  return { valid: true };
                },
              },
              {
                name: 'reserve-inventory',
                execute: async (ctx) => {
                  // Simulate inventory reservation
                  ctx.reservationId = `res-${id}`;
                  return { reservationId: ctx.reservationId };
                },
                compensate: async (ctx) => {
                  // Simulate release
                  ctx.released = true;
                },
              },
              {
                name: 'update-status',
                execute: async (ctx) => {
                  await OrderModel.findByIdAndUpdate(ctx.orderId, { status: 'confirmed' });
                  return { status: 'confirmed' };
                },
                compensate: async (ctx) => {
                  await OrderModel.findByIdAndUpdate(ctx.orderId, { status: 'cancelled' });
                },
              },
            ]);

            if (!result.success) {
              return reply.code(422).send({
                success: false,
                error: result.error,
                failedStep: result.failedStep,
              });
            }

            return reply.code(200).send({
              success: true,
              data: result.results,
            });
          },
        },
        {
          method: 'POST',
          path: '/:id/checkout-fail',
          summary: 'Checkout that always fails at payment step',
          permissions: requireAuth(),
          wrapHandler: false,
          handler: async (request, reply) => {
            const { id } = request.params as { id: string };

            const result = await withCompensation('checkout-fail', [
              {
                name: 'reserve',
                execute: async () => ({ reserved: true }),
                compensate: async () => {
                  // Mark order as rolled back
                  await OrderModel.findByIdAndUpdate(id, { status: 'rolled-back' });
                },
              },
              {
                name: 'charge',
                execute: async () => { throw new Error('Card declined'); },
              },
            ]);

            return reply.code(422).send({
              success: false,
              error: result.error,
              failedStep: result.failedStep,
              compensated: result.completedSteps,
            });
          },
        },
      ],
    });

    app = await createApp({
      preset: 'testing',
      auth: {
        type: 'jwt',
        jwt: { secret: 'test-secret-for-compensation-e2e' },
      },
    });

    await app.register(orderResource.toPlugin());
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
    await connection.close();
    await mongoServer.stop();
  });

  // ==========================================================================
  // Auth enforcement
  // ==========================================================================

  describe('auth enforcement', () => {
    it('returns 401 on checkout without token', async () => {
      const order = await OrderModel.create({ items: ['widget'], total: 10 });

      const res = await app.inject({
        method: 'POST',
        url: `/orders/${order._id}/checkout`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==========================================================================
  // Successful checkout
  // ==========================================================================

  describe('successful checkout', () => {
    it('runs all compensation steps and updates order status', async () => {
      const order = await OrderModel.create({ items: ['widget', 'gadget'], total: 50 });

      // Generate a JWT token
      const token = app.jwt.sign({ sub: 'user-1', role: ['admin'] });

      const res = await app.inject({
        method: 'POST',
        url: `/orders/${order._id}/checkout`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.validate).toEqual({ valid: true });
      expect(body.data['reserve-inventory']).toEqual(
        expect.objectContaining({ reservationId: expect.stringContaining('res-') }),
      );
      expect(body.data['update-status']).toEqual({ status: 'confirmed' });

      // Verify DB was actually updated
      const updated = await OrderModel.findById(order._id).lean();
      expect(updated!.status).toBe('confirmed');
    });
  });

  // ==========================================================================
  // Failed checkout with compensation
  // ==========================================================================

  describe('failed checkout with rollback', () => {
    it('compensates completed steps when payment fails', async () => {
      const order = await OrderModel.create({ items: ['thing'], total: 99, status: 'pending' });
      const token = app.jwt.sign({ sub: 'user-1', role: ['admin'] });

      const res = await app.inject({
        method: 'POST',
        url: `/orders/${order._id}/checkout-fail`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Card declined');
      expect(body.failedStep).toBe('charge');
      expect(body.compensated).toEqual(['reserve']);

      // Verify compensation actually ran — order status rolled back in DB
      const updated = await OrderModel.findById(order._id).lean();
      expect(updated!.status).toBe('rolled-back');
    });
  });

  // ==========================================================================
  // 404 for non-existent order
  // ==========================================================================

  describe('edge cases', () => {
    it('returns 404 for non-existent order', async () => {
      const token = app.jwt.sign({ sub: 'user-1' });
      const fakeId = new mongoose.Types.ObjectId();

      const res = await app.inject({
        method: 'POST',
        url: `/orders/${fakeId}/checkout`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
