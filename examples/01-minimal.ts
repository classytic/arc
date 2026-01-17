/**
 * Arc Example 1: Minimal
 *
 * Uses MongoKit's Repository for CRUD operations.
 * Good for simple REST APIs with no custom logic.
 */

import Fastify from 'fastify';
import mongoose from 'mongoose';
import { defineResource, createMongooseAdapter, BaseController } from '@classytic/arc';
import { Repository } from '@classytic/mongokit';

// Model
const todoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  completed: { type: Boolean, default: false },
}, { timestamps: true });

const Todo = mongoose.model('Todo', todoSchema);
const todoRepository = new Repository(Todo);

// Resource (Arc auto-generates REST API)
const todoResource = defineResource({
  name: 'todo',
  prefix: '/todos',

  adapter: createMongooseAdapter({
    model: Todo,
    repository: todoRepository as any, // Type mismatch - works at runtime
  }),

  controller: new BaseController(todoRepository as any),

  permissions: { list: [], get: [], create: [], update: [], delete: [] },
});

// Server
const app = Fastify({ logger: true });
app.get('/health', async () => ({ status: 'ok' }));
await app.register(todoResource.toPlugin());

await mongoose.connect('mongodb://localhost:27017/arc-minimal');
await app.listen({ port: 3000, host: '0.0.0.0' });

console.log('✅ API: http://localhost:3000/todos');
