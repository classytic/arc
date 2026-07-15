/**
 * Domain-event declaration on a resource — name, optional handler, and
 * payload schema for the `events:` block of a resource definition.
 */

export interface EventDefinition {
  name: string;
  /** Optional handler — events are published via `fastify.events.publish()`. */
  handler?: (data: unknown) => Promise<void> | void;
  /**
   * JSON Schema or Zod v4 schema for event payload. Typed `unknown` so Zod
   * class instances assign without a cast (same convention as
   * `ActionDefinition.schema` and `RouteDefinition.schema`).
   */
  schema?: unknown;
  description?: string;
}
