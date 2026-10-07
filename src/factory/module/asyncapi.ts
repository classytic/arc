/**
 * The module graph as an AsyncAPI 3.0 document — one channel per event (addressed by the event
 * name, payload from the event registry), a `send` operation for its owner and a `receive` for
 * every consumer (wildcards resolved). The standard format tooling, docs and contract tests read.
 */
import { analyzeModuleGraph, type ModuleGraph, type ModuleGraphAnalysis } from "./graph.js";

/** The slice of an event registry's `catalog()` the export reads. */
export interface AsyncApiCatalogEntry {
  readonly name: string;
  readonly version: number;
  readonly description?: string | undefined;
  readonly schema?: unknown;
}

export interface AsyncApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

/** A JSON-Pointer-safe id for an event name. */
const idOf = (event: string): string => event.replace(/[^A-Za-z0-9_.-]/g, "_");

export function toAsyncApi(
  graph: ModuleGraph,
  catalog: readonly AsyncApiCatalogEntry[],
  info: AsyncApiInfo,
  analysis: ModuleGraphAnalysis = analyzeModuleGraph(graph),
): Record<string, unknown> {
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const channels: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const kindOf = new Map(graph.modules.map((m) => [m.name, m.kind]));

  const ensureChannel = (event: string): string => {
    const id = idOf(event);
    if (channels[id]) return id;
    const entry = byName.get(event);
    messages[id] = {
      name: event,
      ...(entry?.description ? { summary: entry.description } : {}),
      payload: entry?.schema ?? {},
      ...(entry ? { "x-version": entry.version } : { "x-uncatalogued": true }),
    };
    channels[id] = {
      address: event,
      messages: { [id]: { $ref: `#/components/messages/${id}` } },
    };
    return id;
  };

  const operation = (module: string, action: "send" | "receive", event: string): void => {
    const id = ensureChannel(event);
    operations[`${module}.${action}.${id}`] = {
      action,
      channel: { $ref: `#/channels/${id}` },
      messages: [{ $ref: `#/channels/${id}/messages/${id}` }],
      tags: [{ name: module }],
      "x-arc-kind": kindOf.get(module),
    };
  };

  for (const [event, owners] of analysis.owners)
    for (const owner of owners) operation(owner, "send", event);
  for (const [consumer, byPattern] of analysis.reaches) {
    for (const events of byPattern.values())
      for (const event of events) operation(consumer, "receive", event);
  }

  return {
    asyncapi: "3.0.0",
    info: {
      title: info.title,
      version: info.version,
      ...(info.description ? { description: info.description } : {}),
    },
    channels,
    operations,
    components: { messages },
  };
}
