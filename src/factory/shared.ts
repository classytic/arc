/**
 * Shared types for factory modules.
 */

// biome-ignore lint: Fastify plugin types vary per package — intentional loose type
export type FastifyPlugin = (...args: any[]) => any;
