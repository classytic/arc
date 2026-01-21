/**
 * Arc Starter - Factory Pattern (Production-Ready)
 *
 * Uses createApp() for production-ready setup with:
 * - Environment-based presets
 * - Automatic security plugin registration
 * - Clean TypeScript with Zero Casts
 *
 * Run: npm run dev:factory
 */

import mongoose from 'mongoose';
import { createApp, defineResource, createMongooseAdapter, BaseController } from '@classytic/arc';
import { Repository } from '@classytic/mongokit';

const PORT = Number(process.env.PORT) || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/arc-starter';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

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
// Create App with Factory
// ============================================================================

async function startServer() {
  try {
    // Connect database first
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Create app with factory pattern
    const app = await createApp({
      preset: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      auth: { jwt: { secret: JWT_SECRET } },

      // Override preset defaults
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
      },

      // Disable some plugins for simplicity
      helmet: false,
      rateLimit: false,
      compression: false,

      // Custom plugins registration
      plugins: async (fastify) => {
        // Health check
        fastify.get('/health', async () => ({
          status: 'ok',
          timestamp: new Date().toISOString()
        }));

        // Register Todo resource
        await fastify.register(todoResource.toPlugin());
      },
    });

    // Start listening
    await app.listen({ port: PORT, host: '0.0.0.0' });

    app.log.info('🚀 Arc Starter (Factory Pattern) running');
    app.log.info(`✅ Server: http://localhost:${PORT}`);
    app.log.info(`✅ Health: http://localhost:${PORT}/health`);
    app.log.info(`✅ Todos: http://localhost:${PORT}/todos`);
    app.log.info('✨ Clean TypeScript - Zero casts needed!');

  } catch (err) {
    console.error('❌ STARTUP ERROR:', err);
    process.exit(1);
  }
}

startServer();
