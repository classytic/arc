/**
 * Arc Example 1: Minimal
 *
 * The flagship path: `createApp()` + `defineResource()`. One config,
 * one resource, full CRUD with auth-shaped defaults baked in.
 *
 * Run it:
 *   npx tsx examples/01-minimal.ts
 *   curl http://localhost:3000/todos
 */

import mongoose from 'mongoose';
import { defineResource, permissions } from '@classytic/arc';
import { createApp } from '@classytic/arc/factory';
import { Repository } from '@classytic/mongokit';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';

// Model
const todoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    completed: { type: Boolean, default: false },
  },
  { timestamps: true },
);
const Todo = mongoose.model('Todo', todoSchema);
const todoRepository = new Repository(Todo);

// Resource - one-liner CRUD API
const todoResource = defineResource({
  name: 'todo',
  adapter: createMongooseAdapter(Todo, todoRepository),
  permissions: permissions.fullPublic(),
});

// App - convention-driven boot. createApp() wires logger, security
// defaults, error handler, health route, and resource registration.
await mongoose.connect('mongodb://localhost:27017/arc-minimal');

const app = await createApp({
  resources: [todoResource],
});

await app.listen({ port: 3000, host: '0.0.0.0' });
app.log.info('API ready: http://localhost:3000/todos');
