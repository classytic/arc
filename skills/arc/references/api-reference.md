# Subpath import map

Import only from these subpaths (tree-shaken, no deep imports). Authoritative list: `api-surface.json`. Adapters live in kits (`@classytic/mongokit/adapter`, `@classytic/sqlitekit/adapter`, `@classytic/prismakit/adapter`); adapter and repository types come from `@classytic/repo-core/adapter` and `@classytic/repo-core/repository`. Event types come from `@classytic/primitives/events`, the outbox contract from `@classytic/primitives/outbox`. `@classytic/arc/types` and `@classytic/arc/types/storage` are type-only.

| Subpath | Main exports |
|---|---|
| `@classytic/arc` | `defineResource`, `defineAction`, `defineAggregation`, `defineResourceVariants`, `mergeResourceConfig`, `BaseController`, `BaseCrudController`, `BulkMixin`, `SlugMixin`, `SoftDeleteMixin`, `TreeMixin`, permission helpers, `ArcError`, `NotFoundError`, `ValidationError`, `createDomainError`, constants (`CRUD_OPERATIONS`, `DEFAULT_LIMIT` ...) |
| `/core` | Same resource and controller API plus `routeInput`, `crudInput`, `parsed`, `noPayloadSchema`, `createCrudRouter`, `QueryResolver`, `AccessControl`, `BodySanitizer`, `validateResourceConfig` |
| `/factory` | `createApp`, `createWorker`, `loadResources`, `defineModule`, `extendModule`, `getModuleExports`, `orderModules`, `planModules`, `verifyModuleGraph`, `renderModuleGraph`, `toAsyncApi`, `toFetchHandler`, `eventTopology`, `verifyEventDurability`, `createRelayNudge`, presets (`productionPreset`, `developmentPreset`, `testingPreset`, `edgePreset`) |
| `/permissions` | `allowPublic`, `requireAuth`, `requireRoles`, `requireOwnership`, `requireOrgMembership`, `requireOrgRole`, `requireTeamMembership`, `requireServiceScope`, `requireScopeContext`, `requireOrgInScope`, `requirePlatformRole`, `requireGrant`, `requireAgentScope`, `requireMandate`, `requireDPoP`, `allOf`, `anyOf`, `not`, `when`, `allow`, `deny`, `denyAll`, `permissionMatrix`, `createDynamicPermissionMatrix`, `createRoleHierarchy`, `fields`, `roles`, `introspectModule` |
| `/scope` | `getUserId`, `getOrgId`, `getOrgRoles`, `getTeamId`, `getClientId`, `getScopeContext`, `getRequestScope`, `getServiceScopes`, `getMandate`, `getDPoPJkt`, `isMember`, `isService`, `isElevated`, `isAuthenticated`, `hasOrgAccess`, `isOrgInScope`, `requireUserId`, `requireOrgId`, `requireTeamId`, `requireClientId`, `elevationPlugin`, `createTenantKeyGenerator`, `PUBLIC_SCOPE`, `AUTHENTICATED_SCOPE` |
| `/presets` (+ `/presets/tenant`, `/files-upload`, `/search`) | `multiTenantPreset`, `softDeletePreset`, `bulkPreset`, `slugLookupPreset`, `treePreset`, `ownedByUserPreset`, `auditedPreset`, `searchPreset`, `filesUploadPreset`, `registerPreset`, `applyPresets` |
| `/auth` (+ `/auth/redis`, `/auth/audit`) | `authPlugin`, `createBetterAuthAdapter`, `extractBetterAuthOpenApi`, `createSessionManager`, `MemorySessionStore`, `RedisSessionStore`, `wireBetterAuthAudit` |
| `/scim` | `scimPlugin`, `parseScimFilter`, `parseScimPatch`, `ScimError`, `DEFAULT_USER_MAPPING`, `DEFAULT_GROUP_MAPPING`, `SCIM_USER_SCHEMA`, `SCIM_GROUP_SCHEMA` |
| `/cache` | `QueryCache`, `queryCachePlugin`, `MemoryCacheStore`, `RedisCacheStore`, `ioredisAsCacheClient`, `upstashAsCacheClient`. Repo-bound cache: `cachePlugin` from `@classytic/repo-core/cache` |
| `/events` | `eventPlugin`, `MemoryEventTransport`, `defineEvent`, `createEventRegistry`, `withRetry`, `withInbox`, `withSubscriberId`, `wrapWithSchema`, `subscribeWithSchema`, `wrapWithBoundary`, `subscribeWithBoundary`, `createDeadLetterPublisher`, `EventOutbox`, `MemoryOutboxStore`, `repositoryAsOutboxStore`, `createOutboxModule`, `exponentialBackoff`, `readOutboxHealth`, `crudEventType`, `ARC_LIFECYCLE_EVENTS` |
| `/events/redis`, `/events/redis-stream` | `RedisEventTransport`, `RedisStreamTransport` |
| `/outbox-admin` | `createOutboxAdminModule` |
| `/plugins` | `healthPlugin`, `gracefulShutdownPlugin`, `ssePlugin`, `metricsPlugin`, `versioningPlugin`, `schedulesPlugin`, `cachingPlugin`, `pressurePlugin`, `realtimePlugin`, `requestIdPlugin`, `errorHandlerPlugin`, `createPlugin`, `createDailyGate`, `createMemoryDailyLedger`; types `DailyLedger`, `DailyScheduleOptions`, `ScheduleRunContext`, `ScheduleDefinition` |
| `/plugins/tracing`, `/plugins/response-cache` | `tracingPlugin`, `traced`, `createSpan`; `responseCachePlugin` |
| `/audit` | `auditPlugin`, `MemoryAuditStore`, `repositoryAsAuditStore`, `createAuditEntry` |
| `/idempotency` (+ `/idempotency/redis`) | `idempotencyPlugin`, `MemoryIdempotencyStore`, `repositoryAsIdempotencyStore`, `IdempotencyStoreMisconfiguredError`; `RedisIdempotencyStore` |
| `/usage` | `usagePlugin`, `MemoryUsageStore`, `RedisUsageStore`, `usagePeriod`, `requireQuota` |
| `/hooks`, `/pipeline`, `/middleware` | `createHookSystem`, `beforeCreate`, `afterCreate`, `beforeUpdate` ...; `pipe`, `guard`, `transform`, `intercept`; `multipartBody` |
| `/context`, `/logger` | `requestContext`, `transactionContext`, `runWorkScope`; `arcLog`, `configureArcLogger` |
| `/registry`, `/discovery`, `/docs` | `ResourceRegistry`, `introspectionPlugin`; `discoverResources`; `openApiPlugin`, `scalarPlugin`, `buildOpenApiSpec` |
| `/schemas` | `Type`, `ArcListResponse`, `ArcErrorResponse`, `ArcPaginationQuery` |
| `/utils` | `createStateMachine`, `CircuitBreaker`, `withCompensation`, `defineGuard`, `declareRuntimeCapability`, `createQueryParser`, `ArcQueryParser`, `createError`, `pipeUIMessageStreamToReply`, `listResponse`, `errorContractSchema`, error classes |
| `/migrations` | `defineMigration`, `MigrationRunner`, `MigrationRegistry`, `MongoMigrationStore` |
| `/cleanup` | `createDataCleanupModule`, `createCleanupService`, `createCleanupRegistry`, `recipeFromSteps` |
| `/encryption` | `encryptionPlugin`, `encryptField`, `decryptField`, `createStaticKeyProvider` |
| `/mcp` (+ `/mcp/testing`) | `mcpPlugin`, `defineTool`, `definePrompt`, `resourceToTools`, `fieldRulesToZod`, `createMcpServer`; `createTestMcpClient` |
| `/integrations/jobs` | `jobsPlugin`, `defineJob` |
| `/integrations/websocket` (+ `-redis`, `-pushref-redis`) | `websocketPlugin`, `RoomManager`, `GeoRoom`; `RedisWebSocketAdapter`; `RedisPushRefStore` |
| `/integrations/event-gateway`, `/streamline`, `/webhooks` | `eventGatewayPlugin`; `streamlinePlugin`; `webhookPlugin`, `verifyWebhook`, `createDurableWebhookModule` |
| `/testing` (+ `/testing/storage`, `/cleanup`, `/outbox`, `/ports`) | `createTestApp`, `expectArc`, `createHttpTestHarness`, `bootModuleApp`, `createTestFixtures`, `runStorageContract`, `runOutboxStoreContract`, `assertRequiresPorts` |
| `/cli` | `describe`, `doctor`, `generate`, `init`, `introspect`, `exportDocs` |

## Notes

- No default exports except `fp()`-wrapped plugin entry files.
- Type-only subpaths compile to `export {}`.
- Idempotency backed by a repository: the key path must survive query filtering. A Mongoose schema with no declared paths under global `strictQuery: true` strips every filter key, so one row absorbs all keys. Use `new Schema({ _id: String }, { strict: false, strictQuery: false, timestamps: false })`. The plugin's boot self-check (`selfCheck: false` disables) refuses to start on this.
- Lock contract for `schedules.lock` and `MigrationRunner.lock`: `LockAdapter` from `@classytic/repo-core/lock`.
