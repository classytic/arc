/**
 * The module graph — which modules are active, which events each OWNS, which it consumes — and
 * the boot-time checks that keep it honest.
 *
 * - A `kind: 'bridge'` module joins domains: it is ACTIVE only when every `dependsOn` module is
 *   composed, and dropped (with the reason recorded) otherwise — never a boot error. Switching a
 *   domain off therefore removes every bridge that touched it, with no gate code anywhere.
 * - `publishes` names the facts a module owns. What it consumes is DERIVED from its
 *   `eventHandlers`, so it is never declared twice.
 * - The graph is two incidence relations over modules × events — P (publishes) and C (consumes).
 *   `analyzeModuleGraph` resolves them ONCE (the pattern × event matching is the only real cost);
 *   verification, rendering and `dependentsOf` all read that one analysis.
 */
import { createEventRouter, matchEventPattern } from "@classytic/primitives/events";
import type { ArcModule } from "./types.js";

export type ModuleKind = "domain" | "bridge" | "platform" | "aggregator";

/** How strictly the event graph is checked at boot. */
export type ModuleGraphMode = "strict" | "warn" | "off";

export interface ModuleGraphOptions {
  /** Default `'off'`. `'strict'` fails boot on any issue; `'warn'` logs each one. */
  readonly events?: ModuleGraphMode;
  /**
   * Event patterns published by something OUTSIDE the module graph (a plugin, a webhook
   * bridge, another service) — a consumer of one of these is satisfied without a module owner.
   */
  readonly externalEvents?: readonly string[];
}

export interface SkippedBridge {
  readonly name: string;
  /** The `dependsOn` modules that are not active. */
  readonly missing: readonly string[];
}

export interface ModuleGraphNode {
  readonly name: string;
  readonly kind: ModuleKind;
  /** Owner prefixes every owned event carries — `eventNamespace`, or the module name. */
  readonly namespaces: readonly string[];
  readonly dependsOn: readonly string[];
  readonly publishes: readonly string[];
  readonly consumes: readonly string[];
}

export interface ModuleGraph {
  readonly modules: readonly ModuleGraphNode[];
  readonly skippedBridges: readonly SkippedBridge[];
  readonly externalEvents: readonly string[];
}

export interface ModuleGraphIssue {
  readonly code: "duplicate-owner" | "outside-namespace" | "no-publisher";
  readonly module: string;
  readonly event: string;
  readonly message: string;
}

/** The resolved incidence: who owns each event, and what each consumed pattern reaches. */
export interface ModuleGraphAnalysis {
  /** Published event → owning modules (more than one is a `duplicate-owner` issue). */
  readonly owners: ReadonlyMap<string, readonly string[]>;
  /** Module → consumed pattern → the published events it matches. */
  readonly reaches: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** D = C·Pᵀ: consumer → publisher → the events flowing between them. */
  readonly coupling: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
}

export function moduleKind(m: ArcModule): ModuleKind {
  return m.kind ?? "domain";
}

/** The event names a module owns. */
export function publishedEvents(m: ArcModule): string[] {
  return (m.publishes ?? []).map((e) => (typeof e === "string" ? e : e.name));
}

/** `order` owns `order:placed` and `order.placed` — `:` for new events, `.` for kernels' existing ones. */
export function ownsEvent(namespace: string, event: string): boolean {
  return event.startsWith(`${namespace}:`) || event.startsWith(`${namespace}.`);
}

/**
 * Drop every bridge whose `dependsOn` is not fully composed — to a fixpoint, so a bridge that
 * depends on a dropped bridge is dropped too. Domain and platform modules are never dropped:
 * their missing dependencies stay a hard error in `orderModules`.
 */
export function activateBridges(modules: readonly ArcModule[]): {
  active: ArcModule[];
  skipped: SkippedBridge[];
} {
  let active = [...modules];
  const skipped: SkippedBridge[] = [];
  for (;;) {
    const names = new Set(active.map((m) => m.name));
    const drop = active.filter(
      (m) => moduleKind(m) === "bridge" && (m.dependsOn ?? []).some((d) => !names.has(d)),
    );
    if (drop.length === 0) return { active, skipped };
    for (const m of drop) {
      skipped.push({ name: m.name, missing: (m.dependsOn ?? []).filter((d) => !names.has(d)) });
    }
    const dropped = new Set(drop.map((m) => m.name));
    active = active.filter((m) => !dropped.has(m.name));
  }
}

/** The CRUD route shape the registry records — enough to know which mutations actually mounted. */
export interface CrudSurface {
  readonly name: string;
  readonly adapter?: unknown;
  readonly disableDefaultRoutes?: boolean | undefined;
  readonly disabledRoutes?: readonly string[] | undefined;
}

/**
 * The events arc auto-emits for a resource (`<name>.created|updated|deleted`) — only for
 * mutations that actually MOUNTED. Overstating would satisfy a consumer that never receives one.
 */
export function crudEventsOf(r: CrudSurface): string[] {
  if (!r.adapter || r.disableDefaultRoutes) return [];
  const disabled = new Set(r.disabledRoutes ?? []);
  return (["create", "update", "delete"] as const)
    .filter((op) => !disabled.has(op))
    .map((op) => `${r.name}.${op}d`);
}

/** What arc knows a module publishes without it declaring — its resources' CRUD events. */
export interface DerivedPublishes {
  readonly publishes: readonly string[];
  /** Resource names — a module owns its resources' events. */
  readonly namespaces: readonly string[];
}

export function buildModuleGraph(
  modules: readonly ArcModule[],
  consumedByModule: ReadonlyMap<string, readonly string[]>,
  skippedBridges: readonly SkippedBridge[],
  externalEvents: readonly string[] = [],
  derived: ReadonlyMap<string, DerivedPublishes> = new Map(),
): ModuleGraph {
  return Object.freeze({
    modules: Object.freeze(
      modules.map((m) =>
        Object.freeze({
          name: m.name,
          kind: moduleKind(m),
          namespaces: Object.freeze([
            ...new Set([
              ...(m.eventNamespace === undefined ? [m.name] : [m.eventNamespace].flat()),
              ...(derived.get(m.name)?.namespaces ?? []),
            ]),
          ]),
          dependsOn: Object.freeze([...(m.dependsOn ?? [])]),
          publishes: Object.freeze([
            ...new Set([...publishedEvents(m), ...(derived.get(m.name)?.publishes ?? [])]),
          ]),
          consumes: Object.freeze([...new Set(consumedByModule.get(m.name) ?? [])]),
        }),
      ),
    ),
    skippedBridges: Object.freeze([...skippedBridges]),
    externalEvents: Object.freeze([...externalEvents]),
  });
}

/** Resolve the graph's incidence once — every check and view reads this. */
export function analyzeModuleGraph(graph: ModuleGraph): ModuleGraphAnalysis {
  const owners = new Map<string, string[]>();
  for (const m of graph.modules) {
    for (const event of m.publishes) {
      const list = owners.get(event);
      if (list) list.push(m.name);
      else owners.set(event, [m.name]);
    }
  }
  // Inverted: register every consumed pattern once, then route each published event —
  // O(events × name length), never patterns × events.
  const router = createEventRouter<{ readonly module: string; readonly pattern: string }>();
  const reaches = new Map<string, Map<string, string[]>>();
  const coupling = new Map<string, Map<string, string[]>>();
  for (const m of graph.modules) {
    const byPattern = new Map<string, string[]>();
    for (const pattern of m.consumes) {
      byPattern.set(pattern, []);
      router.add(pattern, { module: m.name, pattern });
    }
    reaches.set(m.name, byPattern);
    coupling.set(m.name, new Map());
  }
  for (const [event, publishers] of owners) {
    for (const sub of router.route(event)) {
      reaches.get(sub.module)?.get(sub.pattern)?.push(event);
      const byPublisher = coupling.get(sub.module) as Map<string, string[]>;
      for (const publisher of publishers) {
        if (publisher === sub.module) continue;
        const list = byPublisher.get(publisher);
        if (!list) byPublisher.set(publisher, [event]);
        else if (list[list.length - 1] !== event) list.push(event);
      }
    }
  }
  return { owners, reaches, coupling };
}

/** Every issue in the graph — empty when it is sound. */
export function verifyModuleGraph(
  graph: ModuleGraph,
  analysis: ModuleGraphAnalysis = analyzeModuleGraph(graph),
): ModuleGraphIssue[] {
  const issues: ModuleGraphIssue[] = [];
  for (const [event, owners] of analysis.owners) {
    for (const extra of owners.slice(1)) {
      issues.push({
        code: "duplicate-owner",
        module: extra,
        event,
        message: `event "${event}" is published by both "${owners[0]}" and "${extra}" — an event has exactly one owner.`,
      });
    }
  }
  for (const m of graph.modules) {
    for (const event of m.publishes) {
      if (m.namespaces.some((ns) => ownsEvent(ns, event))) continue;
      issues.push({
        code: "outside-namespace",
        module: m.name,
        event,
        message: `module "${m.name}" publishes "${event}" outside its namespace(s) ${m.namespaces.map((n) => `"${n}"`).join(", ")} — a module publishes its OWN facts; a process joining two domains is a bridge with its own namespace.`,
      });
    }
    for (const [pattern, hit] of analysis.reaches.get(m.name) ?? []) {
      if (hit.length > 0) continue;
      if (graph.externalEvents.some((ext) => ext === pattern || matchEventPattern(ext, pattern)))
        continue;
      issues.push({
        code: "no-publisher",
        module: m.name,
        event: pattern,
        message: `module "${m.name}" consumes "${pattern}", which no active module publishes — declare the owner's \`publishes\`, list it in \`moduleGraph.externalEvents\`, or make "${m.name}" a bridge of the module that owns it.`,
      });
    }
  }
  return issues;
}

/**
 * What stops working if `name` is switched off: modules consuming events only it publishes
 * (a column of the coupling matrix), and bridges that `dependsOn` it — which arc drops.
 */
export function dependentsOf(
  graph: ModuleGraph,
  name: string,
  analysis: ModuleGraphAnalysis = analyzeModuleGraph(graph),
): { starved: { module: string; events: string[] }[]; droppedBridges: string[] } {
  const starved: { module: string; events: string[] }[] = [];
  for (const [consumer, byPublisher] of analysis.coupling) {
    const events = (byPublisher.get(name) ?? []).filter(
      (e) => (analysis.owners.get(e) ?? []).length === 1,
    );
    if (events.length > 0) starved.push({ module: consumer, events: [...new Set(events)] });
  }
  const droppedBridges = graph.modules
    .filter((m) => m.kind === "bridge" && m.dependsOn.includes(name))
    .map((m) => m.name);
  return { starved, droppedBridges };
}

/**
 * The graph as Markdown — modules, the coupling between them, then every event with its owner
 * and consumers. Generate it into the repo so people and agents read the map instead of grepping.
 */
export function renderModuleGraph(
  graph: ModuleGraph,
  analysis: ModuleGraphAnalysis = analyzeModuleGraph(graph),
): string {
  const lines: string[] = [
    "# Module graph",
    "",
    "| module | kind | depends on | publishes | consumes |",
    "|---|---|---|---|---|",
  ];
  for (const m of graph.modules) {
    lines.push(
      `| ${m.name} | ${m.kind} | ${list(m.dependsOn)} | ${list(m.publishes)} | ${list(m.consumes)} |`,
    );
  }
  if (graph.skippedBridges.length > 0) {
    lines.push("", "## Inactive bridges", "", "| bridge | missing |", "|---|---|");
    for (const b of graph.skippedBridges) lines.push(`| ${b.name} | ${list(b.missing)} |`);
  }
  lines.push(
    "",
    "## Coupling — whose facts each module consumes",
    "",
    "| consumer | publisher | events |",
    "|---|---|---|",
  );
  for (const [consumer, byPublisher] of analysis.coupling) {
    for (const [publisher, events] of byPublisher) {
      lines.push(`| ${consumer} | ${publisher} | ${list([...new Set(events)])} |`);
    }
  }
  lines.push("", "## Events", "", "| event | owner | consumers |", "|---|---|---|");
  const consumersOf = new Map<string, Set<string>>();
  for (const [consumer, byPattern] of analysis.reaches) {
    for (const hit of byPattern.values()) {
      for (const event of hit)
        consumersOf.set(event, (consumersOf.get(event) ?? new Set()).add(consumer));
    }
  }
  for (const [event, owners] of [...analysis.owners].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(
      `| ${event} | ${owners.join(", ")} | ${list([...(consumersOf.get(event) ?? [])])} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function list(items: readonly string[]): string {
  return items.length === 0 ? "—" : items.map((i) => `\`${i}\``).join(", ");
}

/**
 * Divide the graph by its coupling: Tarjan's strongly connected components over D = C·Pᵀ.
 * A component of more than one module is an EVENT CYCLE — modules that consume each other's
 * facts and so can only be deployed, disabled or reasoned about together. `layers` is the
 * condensation in dependency order: each layer consumes only from layers before it, so a layer's
 * modules can be verified, tested or split out in parallel.
 */
export function eventTopology(
  graph: ModuleGraph,
  analysis: ModuleGraphAnalysis = analyzeModuleGraph(graph),
): { cycles: string[][]; layers: string[][] } {
  const names = graph.modules.map((m) => m.name);
  const edges = (n: string) => [...(analysis.coupling.get(n)?.keys() ?? [])];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      components.push(component.sort());
    }
  };
  for (const n of names) if (!index.has(n)) visit(n);

  // Tarjan emits components dependencies-first; a component's layer is 1 + its deepest dependency's.
  const componentOf = new Map<string, number>();
  components.forEach((c, i) => {
    for (const n of c) componentOf.set(n, i);
  });
  const depth = components.map(() => 0);
  components.forEach((c, i) => {
    for (const n of c) {
      for (const dep of edges(n)) {
        const j = componentOf.get(dep) as number;
        if (j !== i) depth[i] = Math.max(depth[i] as number, (depth[j] as number) + 1);
      }
    }
  });
  const layers: string[][] = [];
  components.forEach((c, i) => {
    const d = depth[i] as number;
    const layer = layers[d] ?? [];
    layer.push(...c);
    layers[d] = layer;
  });
  return {
    cycles: components.filter((c) => c.length > 1),
    layers: layers.filter(Boolean).map((layer) => layer.sort()),
  };
}
