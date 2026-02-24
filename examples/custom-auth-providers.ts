/**
 * Custom Authentication Providers
 *
 * Arc's built-in JWT auth is optional. You can:
 * 1. Replace it entirely with OAuth/SAML/etc.
 * 2. Use it alongside other providers (hybrid auth)
 * 3. Create custom authentication strategies
 */

import { createApp, defineResource, createMongooseAdapter, permissions, allowPublic, requireRoles } from '@classytic/arc';
import type { FastifyInstance } from 'fastify';

// ============================================================================
// Option 1: Replace Arc Auth with OAuth (Google, Facebook, etc.)
// ============================================================================

/**
 * Use @fastify/oauth2 instead of Arc's JWT auth
 *
 * Install: npm install @fastify/oauth2
 */
export async function createOAuthOnlyApp() {
  const app = await createApp({
    environment: 'production',

    // Disable Arc's built-in auth
    jwt: false,
  });

  // Register OAuth2 plugin
  await app.register(require('@fastify/oauth2'), {
    name: 'googleOAuth',
    credentials: {
      client: {
        id: process.env.GOOGLE_CLIENT_ID!,
        secret: process.env.GOOGLE_CLIENT_SECRET!,
      },
      auth: {
        authorizeHost: 'https://accounts.google.com',
        authorizePath: '/o/oauth2/v2/auth',
        tokenHost: 'https://www.googleapis.com',
        tokenPath: '/oauth2/v4/token',
      },
    },
    startRedirectPath: '/auth/google',
    callbackUri: 'http://localhost:8080/auth/google/callback',
    scope: ['profile', 'email'],
  });

  // Google OAuth callback
  app.get('/auth/google/callback', async (request, reply) => {
    try {
      const { token } = await app.googleOAuth.getAccessTokenFromAuthorizationCodeFlow(request);

      // Fetch user info from Google
      const userInfo = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }).then(r => r.json());

      // Create or update user in your database
      const user = await findOrCreateUser({
        email: userInfo.email,
        name: userInfo.name,
        googleId: userInfo.id,
        avatar: userInfo.picture,
      });

      // Issue your own session token (or use cookies)
      const sessionToken = await issueSessionToken(user);

      return reply.send({
        success: true,
        token: sessionToken,
        user,
      });
    } catch (error) {
      return reply.code(401).send({ error: 'OAuth authentication failed' });
    }
  });

  return app;
}

// ============================================================================
// Option 2: Hybrid Auth (JWT + OAuth + API Keys)
// ============================================================================

/**
 * Support multiple authentication methods simultaneously
 */
export async function createHybridAuthApp() {
  const app = await createApp({
    environment: 'production',

    // Keep Arc's JWT auth for regular users
    jwt: {
      secret: process.env.JWT_SECRET,
      expiresIn: '7d',
    },
  });

  // 1. Add OAuth for social login
  await app.register(require('@fastify/oauth2'), {
    name: 'googleOAuth',
    credentials: {
      client: {
        id: process.env.GOOGLE_CLIENT_ID!,
        secret: process.env.GOOGLE_CLIENT_SECRET!,
      },
      auth: {
        authorizeHost: 'https://accounts.google.com',
        authorizePath: '/o/oauth2/v2/auth',
        tokenHost: 'https://www.googleapis.com',
        tokenPath: '/oauth2/v4/token',
      },
    },
    startRedirectPath: '/auth/google',
    callbackUri: `${process.env.API_URL}/auth/google/callback`,
    scope: ['profile', 'email'],
  });

  // 2. Add Facebook OAuth
  await app.register(require('@fastify/oauth2'), {
    name: 'facebookOAuth',
    credentials: {
      client: {
        id: process.env.FACEBOOK_APP_ID!,
        secret: process.env.FACEBOOK_APP_SECRET!,
      },
      auth: {
        authorizeHost: 'https://www.facebook.com',
        authorizePath: '/v12.0/dialog/oauth',
        tokenHost: 'https://graph.facebook.com',
        tokenPath: '/v12.0/oauth/access_token',
      },
    },
    startRedirectPath: '/auth/facebook',
    callbackUri: `${process.env.API_URL}/auth/facebook/callback`,
    scope: ['email', 'public_profile'],
  });

  // 3. Add custom API key authentication
  app.decorate('authenticateApiKey', async (request: any, reply: any) => {
    const apiKey = request.headers['x-api-key'];

    if (!apiKey) {
      return reply.code(401).send({ error: 'API key required' });
    }

    // Validate API key from database
    const client = await ApiKey.findOne({ key: apiKey, active: true });

    if (!client) {
      return reply.code(401).send({ error: 'Invalid API key' });
    }

    // Attach client info to request
    request.apiClient = client;
  });

  // 4. Create unified authentication middleware
  app.decorate('authenticateAny', async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    const apiKey = request.headers['x-api-key'];

    // Try JWT first
    if (authHeader?.startsWith('Bearer ')) {
      try {
        await app.authenticate(request, reply);
        return; // Success
      } catch (error) {
        // Fall through to try other methods
      }
    }

    // Try API key
    if (apiKey) {
      try {
        await app.authenticateApiKey(request, reply);
        return; // Success
      } catch (error) {
        // Fall through
      }
    }

    // No valid authentication
    return reply.code(401).send({ error: 'Authentication required' });
  });

  // Example: Resource with hybrid auth
  const productResource = defineResource({ name: 'product',
    adapter: createMongooseAdapter(ProductModel, productRepo),
    permissions: permissions.publicRead(),

    additionalRoutes: [
      {
        method: 'GET',
        path: '/featured',
        handler: 'getFeatured',
        wrapHandler: true,
        permissions: allowPublic(),
        // Accept JWT OR API key
        preHandler: [app.authenticateAny],
      },
    ],
  });

  await app.register(productResource.toPlugin());

  return app;
}

// ============================================================================
// Option 3: Custom Authentication Strategy
// ============================================================================

/**
 * Create your own authentication from scratch
 */
export async function createCustomAuthApp() {
  const app = await createApp({
    environment: 'production',

    // Disable Arc's auth completely
    jwt: false,
  });

  // Custom authentication decorator
  app.decorate('authenticateCustom', async (request: any, reply: any) => {
    const sessionId = request.cookies.sessionId;

    if (!sessionId) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }

    // Validate session from Redis/database
    const session = await getSessionFromRedis(sessionId);

    if (!session || session.expiresAt < Date.now()) {
      return reply.code(401).send({ error: 'Session expired' });
    }

    // Load user from database
    const user = await User.findById(session.userId);

    if (!user) {
      return reply.code(401).send({ error: 'User not found' });
    }

    // Attach user to request
    request.user = user;
  });

  // Custom authorization decorator
  app.decorate('requireCustomRoles', (...roles: string[]) => {
    return async (request: any, reply: any) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const hasRole = roles.some(role => request.user.roles?.includes(role));

      if (!hasRole) {
        return reply.code(403).send({ error: 'Insufficient permissions' });
      }
    };
  });

  // Use custom auth in resources
  const orderResource = defineResource({ name: 'order',
    adapter: createMongooseAdapter(OrderModel, orderRepo),
    permissions: permissions.authenticated(),

    additionalRoutes: [
      {
        method: 'GET',
        path: '/my-orders',
        handler: 'getMyOrders',
        wrapHandler: true,
        permissions: allowPublic(), // Auth handled by preHandler
        preHandler: [app.authenticateCustom],
      },
      {
        method: 'POST',
        path: '/',
        handler: 'create',
        wrapHandler: true,
        permissions: allowPublic(), // Auth handled by preHandler
        preHandler: [
          app.authenticateCustom,
          app.requireCustomRoles('admin', 'customer'),
        ],
      },
    ],
  });

  await app.register(orderResource.toPlugin());

  return app;
}

// ============================================================================
// Option 4: Passport.js Integration
// ============================================================================

/**
 * Use Passport.js for maximum flexibility
 *
 * Install: npm install @fastify/passport @fastify/secure-session passport-google-oauth20
 */
export async function createPassportApp() {
  const app = await createApp({
    environment: 'production',
    jwt: false,
  });

  // Register session plugin
  await app.register(require('@fastify/secure-session'), {
    secret: process.env.SESSION_SECRET,
    salt: process.env.SESSION_SALT,
    cookie: {
      path: '/',
      httpOnly: true,
      secure: true,
    },
  });

  // Register Passport
  const fastifyPassport = require('@fastify/passport');
  await app.register(fastifyPassport.default);

  // Configure Google Strategy
  const GoogleStrategy = require('passport-google-oauth20').Strategy;

  fastifyPassport.use(
    'google',
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: '/auth/google/callback',
      },
      async (accessToken: string, refreshToken: string, profile: any, done: any) => {
        try {
          const user = await findOrCreateUser({
            googleId: profile.id,
            email: profile.emails[0].value,
            name: profile.displayName,
          });
          done(null, user);
        } catch (error) {
          done(error, null);
        }
      }
    )
  );

  // Serialize/deserialize user
  fastifyPassport.registerUserSerializer(async (user: any) => user._id);
  fastifyPassport.registerUserDeserializer(async (id: string) => {
    return await User.findById(id);
  });

  // Auth routes
  app.get('/auth/google', fastifyPassport.authenticate('google', {
    scope: ['profile', 'email'],
  }));

  app.get('/auth/google/callback',
    fastifyPassport.authenticate('google', {
      successRedirect: '/dashboard',
      failureRedirect: '/login',
    })
  );

  // Use Passport's isAuthenticated in resources
  const profileResource = defineResource({ name: 'profile',
    adapter: createMongooseAdapter(ProfileModel, profileRepo),
    permissions: permissions.authenticated(),

    additionalRoutes: [
      {
        method: 'GET',
        path: '/me',
        handler: 'getMe',
        wrapHandler: true,
        permissions: allowPublic(), // Auth handled by preHandler
        preHandler: [(req: any, reply: any) => {
          if (!req.isAuthenticated()) {
            return reply.code(401).send({ error: 'Not authenticated' });
          }
        }],
      },
    ],
  });

  await app.register(profileResource.toPlugin());

  return app;
}

// ============================================================================
// Option 5: SAML/SSO for Enterprise
// ============================================================================

/**
 * Enterprise SSO with SAML
 *
 * Install: npm install passport-saml
 */
export async function createSAMLApp() {
  const app = await createApp({
    environment: 'production',
    jwt: false,
  });

  await app.register(require('@fastify/secure-session'), {
    secret: process.env.SESSION_SECRET,
    salt: process.env.SESSION_SALT,
  });

  const fastifyPassport = require('@fastify/passport');
  await app.register(fastifyPassport.default);

  const SamlStrategy = require('passport-saml').Strategy;

  fastifyPassport.use(
    new SamlStrategy(
      {
        entryPoint: process.env.SAML_ENTRY_POINT,
        issuer: process.env.SAML_ISSUER,
        callbackUrl: `${process.env.API_URL}/auth/saml/callback`,
        cert: process.env.SAML_CERT,
      },
      async (profile: any, done: any) => {
        try {
          const user = await findOrCreateUser({
            email: profile.email,
            name: profile.displayName,
            samlId: profile.nameID,
          });
          done(null, user);
        } catch (error) {
          done(error, null);
        }
      }
    )
  );

  app.get('/auth/saml', fastifyPassport.authenticate('saml'));
  app.post('/auth/saml/callback', fastifyPassport.authenticate('saml'), (req, reply) => {
    reply.redirect('/dashboard');
  });

  return app;
}

// ============================================================================
// Best Practice: Multi-Provider with Unified JWT
// ============================================================================

/**
 * Recommended: Use OAuth for login, JWT for API authentication
 *
 * Flow:
 * 1. User logs in via Google/Facebook (OAuth)
 * 2. Backend creates user in database
 * 3. Backend issues JWT token
 * 4. Frontend uses JWT for all subsequent API calls
 */
export async function createRecommendedAuthApp() {
  const app = await createApp({
    environment: 'production',

    // Enable JWT for API authentication
    jwt: {
      secret: process.env.JWT_SECRET,
      expiresIn: '7d',
    },
  });

  // Register OAuth providers for initial login
  await app.register(require('@fastify/oauth2'), {
    name: 'googleOAuth',
    credentials: {
      client: {
        id: process.env.GOOGLE_CLIENT_ID!,
        secret: process.env.GOOGLE_CLIENT_SECRET!,
      },
      auth: {
        authorizeHost: 'https://accounts.google.com',
        authorizePath: '/o/oauth2/v2/auth',
        tokenHost: 'https://www.googleapis.com',
        tokenPath: '/oauth2/v4/token',
      },
    },
    startRedirectPath: '/auth/google',
    callbackUri: `${process.env.API_URL}/auth/google/callback`,
    scope: ['profile', 'email'],
  });

  // OAuth callback: Issue JWT
  app.get('/auth/google/callback', async (request, reply) => {
    try {
      const { token } = await app.googleOAuth.getAccessTokenFromAuthorizationCodeFlow(request);

      // Get user info from Google
      const userInfo = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }).then(r => r.json());

      // Create or update user
      const user = await User.findOneAndUpdate(
        { email: userInfo.email },
        {
          email: userInfo.email,
          name: userInfo.name,
          avatar: userInfo.picture,
          googleId: userInfo.id,
          lastLogin: new Date(),
        },
        { upsert: true, new: true }
      );

      // Issue JWT using Arc's auth plugin
      const { token: jwtToken, refreshToken } = app.auth.issueTokens({
        _id: user._id,
        email: user.email,
        roles: user.roles,
      });

      return reply.send({
        success: true,
        token: jwtToken,
        refreshToken,
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          roles: user.roles,
        },
      });
    } catch (error) {
      return reply.code(401).send({ error: 'Authentication failed' });
    }
  });

  // All API routes use JWT authentication
  const productResource = defineResource({ name: 'product',
    adapter: createMongooseAdapter(ProductModel, productRepo),
    permissions: permissions.publicReadAdminWrite(),
  });

  await app.register(productResource.toPlugin());

  return app;
}

// ============================================================================
// Helper Functions (implement these in your app)
// ============================================================================

declare const User: any;
declare const ApiKey: any;
declare const ProductModel: any;
declare const productRepo: any;
declare const OrderModel: any;
declare const orderRepo: any;
declare const ProfileModel: any;
declare const profileRepo: any;

async function findOrCreateUser(data: any) {
  return User.findOneAndUpdate(
    { email: data.email },
    { ...data, lastLogin: new Date() },
    { upsert: true, new: true }
  );
}

async function issueSessionToken(user: any): Promise<string> {
  // Implement your session token logic
  return 'session-token';
}

async function getSessionFromRedis(sessionId: string) {
  // Implement Redis session lookup
  return null;
}
