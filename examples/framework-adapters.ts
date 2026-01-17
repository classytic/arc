/**
 * Framework Adapter Examples
 *
 * Using Arc resources with Express, Next.js, and other frameworks.
 */

import { defineResource, createMongooseAdapter } from '@classytic/arc';
import Fastify from 'fastify';

// ============================================================================
// Express Integration
// ============================================================================

/**
 * Mount Arc resources in an Express app
 *
 * Install: npm install fastify @fastify/express
 */
export async function mountArcInExpress() {
  const express = require('express');
  const app = express();

  // Create a Fastify instance for Arc
  const fastify = Fastify({
    logger: false,
  });

  // Register Arc resources
  const productResource = defineResource({
    name: 'product',
    adapter: createMongooseAdapter({
      model: ProductModel,
      repository: productRepository,
    }),
    presets: ['softDelete'],
  });

  await fastify.register(productResource.toPlugin(), { prefix: '/api' });

  // Mount Fastify inside Express
  const fastifyExpress = require('@fastify/express');
  await fastify.register(fastifyExpress);

  // Use as Express middleware
  app.use('/api', fastify.express);

  // Traditional Express routes still work
  app.get('/', (req, res) => {
    res.json({ message: 'Express + Arc' });
  });

  return app;
}

// ============================================================================
// Next.js API Routes
// ============================================================================

/**
 * Use Arc resources in Next.js API routes
 *
 * File: pages/api/products/[...path].ts
 */
export async function createNextjsApiRoute() {
  const fastify = Fastify({
    logger: false,
  });

  // Register Arc resources
  const productResource = defineResource({
    name: 'product',
    adapter: createMongooseAdapter({
      model: ProductModel,
      repository: productRepository,
    }),
  });

  await fastify.register(productResource.toPlugin());
  await fastify.ready();

  // Next.js API handler
  return async (req: any, res: any) => {
    // Convert Next.js request to Fastify format
    const fastifyRequest = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
      query: req.query,
    };

    // Execute Fastify route
    const response = await fastify.inject(fastifyRequest);

    // Send response
    res.status(response.statusCode);
    Object.entries(response.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    res.send(response.body);
  };
}

// ============================================================================
// Standalone API (Recommended)
// ============================================================================

/**
 * Recommended: Run Arc as standalone API
 *
 * This provides best performance and all Arc features.
 */
export async function createStandaloneApi() {
  const { createApp } = require('@classytic/arc');

  const app = await createApp({
    environment: 'production',
    port: 8080,
  });

  // Your frontend (Next.js, React, etc.) calls this API
  // Frontend: http://localhost:3000
  // API:      http://localhost:8080

  return app;
}

// ============================================================================
// Serverless Function (Vercel, Netlify)
// ============================================================================

/**
 * Deploy Arc as serverless function
 *
 * File: api/index.ts (Vercel) or functions/api.ts (Netlify)
 */
export async function createServerlessHandler() {
  let cachedApp: any = null;

  // Cache Fastify instance across invocations
  async function getApp() {
    if (!cachedApp) {
      const { createApp } = require('@classytic/arc');
      cachedApp = await createApp({
        environment: 'production',
        compression: false, // Platform handles compression
        logger: false,      // Use platform logging
      });
      await cachedApp.ready();
    }
    return cachedApp;
  }

  // Serverless handler
  return async (req: any, res: any) => {
    const app = await getApp();

    const response = await app.inject({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
      query: req.query,
    });

    res.status(response.statusCode);
    Object.entries(response.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    res.send(response.body);
  };
}

// ============================================================================
// AWS Lambda with API Gateway
// ============================================================================

/**
 * Deploy Arc to AWS Lambda
 *
 * Install: npm install @fastify/aws-lambda
 */
export async function createLambdaHandler() {
  const awsLambdaFastify = require('@fastify/aws-lambda');
  const { createApp } = require('@classytic/arc');

  // Initialize app once (outside handler)
  const app = await createApp({
    environment: 'production',
    logger: {
      level: 'info',
      base: { lambda: true },
    },
  });

  // Create Lambda handler
  const handler = awsLambdaFastify(app);

  return {
    handler: async (event: any, context: any) => {
      return handler(event, context);
    },
  };
}

// ============================================================================
// Docker Container
// ============================================================================

/**
 * Production Dockerfile for Arc
 *
 * File: Dockerfile
 */
export const DOCKERFILE = `
# Multi-stage build for optimal image size
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

# Production image
FROM node:18-alpine

WORKDIR /app

# Copy built app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 8080

CMD ["node", "dist/index.js"]
`;

// ============================================================================
// Kubernetes Deployment
// ============================================================================

/**
 * Kubernetes manifest for Arc
 *
 * File: k8s/deployment.yaml
 */
export const K8S_DEPLOYMENT = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: arc-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: arc-api
  template:
    metadata:
      labels:
        app: arc-api
    spec:
      containers:
      - name: api
        image: your-registry/arc-api:latest
        ports:
        - containerPort: 8080
        env:
        - name: NODE_ENV
          value: "production"
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: api-secrets
              key: jwt-secret
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: api-secrets
              key: database-url
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: arc-api
spec:
  selector:
    app: arc-api
  ports:
  - port: 80
    targetPort: 8080
  type: LoadBalancer
`;

// ============================================================================
// Docker Compose (Development)
// ============================================================================

/**
 * Docker Compose for local development
 *
 * File: docker-compose.yml
 */
export const DOCKER_COMPOSE = `
version: '3.8'

services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=mongodb://mongo:27017/myapp
      - JWT_SECRET=dev-secret-min-32-chars-long-for-security
      - ALLOWED_ORIGINS=http://localhost:3000
    depends_on:
      - mongo
    volumes:
      - ./src:/app/src
    command: npm run dev

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  mongo-data:
`;

// Placeholder types
declare const ProductModel: any;
declare const productRepository: any;
