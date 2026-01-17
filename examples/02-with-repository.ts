/**
 * Arc Example 2: With Custom Repository
 *
 * Extend MongoKit's Repository to add custom methods.
 * Gives you full control over queries and business logic.
 */

import Fastify from 'fastify';
import mongoose from 'mongoose';
import { defineResource, createMongooseAdapter, BaseController } from '@classytic/arc';
import { Repository } from '@classytic/mongokit';

// Model
const todoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  completed: { type: Boolean, default: false },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
}, { timestamps: true });

const Todo = mongoose.model('Todo', todoSchema);

// Custom Repository (add your own methods)
class TodoRepository extends Repository {
  constructor() {
    super(Todo);
  }

  // Custom method: Get high priority todos
  async getHighPriority() {
    return this.find({ priority: 'high', completed: false });
  }

  // Custom method: Mark all as completed
  async completeAll() {
    return this.Model.updateMany({ completed: false }, { completed: true });
  }
}

const todoRepository = new TodoRepository();

// Resource with custom repository
const todoResource = defineResource({
  name: 'todo',
  prefix: '/todos',

  adapter: createMongooseAdapter({
    model: Todo,
    repository: todoRepository as any,
  }),

  controller: new BaseController(todoRepository as any),

  permissions: { list: [], get: [], create: [], update: [], delete: [] },

  // Add custom routes
  additionalRoutes: [
    {
      method: 'GET',
      path: '/high-priority',
      handler: async () => {
        const todos = await todoRepository.getHighPriority();
        return { success: true, data: todos };
      },
    },
    {
      method: 'POST',
      path: '/complete-all',
      handler: async () => {
        await todoRepository.completeAll();
        return { success: true, message: 'All todos completed' };
      },
    },
  ],
});

// Server
const app = Fastify({ logger: true });
app.get('/health', async () => ({ status: 'ok' }));
await app.register(todoResource.toPlugin());

await mongoose.connect('mongodb://localhost:27017/arc-custom-repo');
await app.listen({ port: 3000, host: '0.0.0.0' });

console.log('✅ API: http://localhost:3000/todos');
console.log('✅ Custom: http://localhost:3000/todos/high-priority');
