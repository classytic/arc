/**
 * Arc Starter - Clean TypeScript with Zero Casts! 🎉
 *
 * Arc v1.0 uses structural typing - MongoKit Repository works seamlessly.
 * Run: npm run dev
 */

import Fastify from 'fastify';
import mongoose from 'mongoose';
import { defineResource, createMongooseAdapter, BaseController } from '@classytic/arc';
import { Repository } from '@classytic/mongokit';

const PORT = Number(process.env.PORT) || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arc-starter';

// ============================================================================
// Todo Model & Repository
// ============================================================================

const todoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  completed: { type: Boolean, default: false },
}, { timestamps: true });

const Todo = mongoose.model('Todo', todoSchema);
const todoRepository = new Repository(Todo);

// ============================================================================
// Todo Resource - NO `as any` CASTS NEEDED! ✅
// ============================================================================

const todoResource = defineResource({
  name: 'todo',
  prefix: '/todos',

  // ✅ TypeScript infers types automatically!
  adapter: createMongooseAdapter({
    model: Todo,
    repository: todoRepository, // No cast needed!
  }),

  // ✅ BaseController accepts MongoKit Repository directly!
  controller: new BaseController(todoRepository), // No cast needed!

  // All routes public for simplicity
  permissions: {
    list: [],
    get: [],
    create: [],
    update: [],
    delete: [],
  },
});

// ============================================================================
// Start Server
// ============================================================================

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));
await app.register(todoResource.toPlugin());

try {
  await mongoose.connect(MONGO_URI);
  await app.listen({ port: PORT, host: '0.0.0.0' });

  app.log.info(`✅ Server running at http://localhost:${PORT}`);
  app.log.info(`✅ API: GET/POST http://localhost:${PORT}/todos`);
  app.log.info('✨ Clean TypeScript - Zero casts needed!');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
