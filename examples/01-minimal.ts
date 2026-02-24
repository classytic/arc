/**
 * Arc Example 1: Minimal
 *
 * Uses defineResource() for zero-config CRUD.
 * Good for simple REST APIs with no custom logic.
 */

import Fastify from 'fastify';
import mongoose from 'mongoose';
import { defineResource, createMongooseAdapter, permissions } from '@classytic/arc';
import { Repository } from '@classytic/mongokit';

// Model
const todoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  completed: { type: Boolean, default: false },
}, { timestamps: true });

const Todo = mongoose.model('Todo', todoSchema);
const todoRepository = new Repository(Todo);

// Resource — one-liner CRUD API
const todoResource = defineResource({
  name: 'todo',
  adapter: createMongooseAdapter(Todo, todoRepository),
  permissions: permissions.fullPublic(),
});

// Server
const app = Fastify({ logger: true });
app.get('/health', async () => ({ status: 'ok' }));
await app.register(todoResource.toPlugin());

await mongoose.connect('mongodb://localhost:27017/arc-minimal');
await app.listen({ port: 3000, host: '0.0.0.0' });

console.log('API: http://localhost:3000/todos');
