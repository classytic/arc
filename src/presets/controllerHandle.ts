/**
 * The controller a preset route builder receives. Presets apply before the
 * controller exists (they feed `controllerOptions` into the auto-built
 * `BaseController`), so each method read returns a function that resolves on
 * the real controller (`this`-bound) when a request runs.
 *
 * Reads made while the routes are BUILT (`handler: controller.getStats`) are
 * recorded; `defineResource` binds the controller and calls `verify()`, so a
 * missing method or controller fails boot, not the first request. A read inside
 * an arrow handler happens per request and cannot be checked here.
 */

import type { ControllerHandler, PresetController, RouteDefinition } from "../types/index.js";
import {
  ArcBootError,
  type BootProblem,
  bootError,
  formatBootProblems,
} from "../utils/bootError.js";

export const PRESET_CONTROLLER_METHOD_MISSING = "preset-controller-method-missing";

export interface PresetControllerHandle {
  readonly controller: PresetController;
  bind(controller: unknown): void;
  /** Throw `ArcBootError` for every build-time read the bound controller cannot serve. */
  verify(routes: readonly RouteDefinition[]): void;
}

interface HandleState {
  preset: string | undefined;
}

const states = new WeakMap<object, HandleState>();

/** Attribute the next build-time reads on `controller` to `presetName` (no-op for a foreign object). */
export function notePresetSource(controller: PresetController, presetName: string): void {
  const state = states.get(controller);
  if (state) state.preset = presetName;
}

export function createPresetControllerHandle(resourceName: string): PresetControllerHandle {
  let bound = false;
  let target: Record<string, unknown> | undefined;
  const methods = new Map<string, ControllerHandler>();
  // "preset\0method" → read; one entry per pair however often it is read.
  const reads = new Map<string, { preset: string | undefined; method: string }>();
  const state: HandleState = { preset: undefined };

  const methodFor = (method: string): ControllerHandler => {
    if (!bound) reads.set(`${state.preset}\0${method}`, { preset: state.preset, method });
    const cached = methods.get(method);
    if (cached) return cached;
    const call: ControllerHandler = async (...args) => {
      const fn = target?.[method];
      if (typeof fn !== "function") {
        throw new Error(
          `Resource '${resourceName}': a preset route called controller.${method}(), but ` +
            (!bound
              ? "the controller is not resolved yet (call the handler from a request)."
              : target
                ? `the controller has no '${method}' method. Add it, or extend BaseController.`
                : "the resource has no controller. Pass `controller`, or give the resource an " +
                  "`adapter` with CRUD routes so arc builds a BaseController."),
        );
      }
      return (fn as ControllerHandler).apply(target, args);
    };
    // Named after the method so the registry keeps reporting it.
    Object.defineProperty(call, "name", { value: method });
    methods.set(method, call);
    return call;
  };

  // Only string keys resolve to methods: `then` and symbol probes (await,
  // inspection) stay undefined so the handle never looks like a thenable.
  const controller = new Proxy({} as PresetController, {
    get: (_t, property) =>
      typeof property === "string" && property !== "then" ? methodFor(property) : undefined,
  });
  states.set(controller, state);

  return {
    controller,
    bind(resolved) {
      bound = true;
      target = (resolved ?? undefined) as Record<string, unknown> | undefined;
    },
    verify(routes) {
      const problems: BootProblem[] = [];
      for (const { preset, method } of reads.values()) {
        if (typeof target?.[method] === "function") continue;
        const fn = methods.get(method);
        const route = routes.find((r) => r.handler === fn || r.rawHandler === fn);
        const at = route ? ` route ${route.method} ${route.path}` : "";
        const where = `preset '${preset ?? "unknown"}'${at}`;
        problems.push({
          code: PRESET_CONTROLLER_METHOD_MISSING,
          message: target
            ? `Resource '${resourceName}': ${where} uses controller.${method}, but the controller has no '${method}' method.`
            : `Resource '${resourceName}': ${where} uses controller.${method}, but the resource has no controller.`,
          fix: target
            ? `Add '${method}' to the controller, or extend BaseController.`
            : "Pass `controller`, or give the resource an `adapter` with CRUD routes so arc builds a BaseController.",
        });
      }
      if (problems.length === 1) throw bootError(problems[0] as BootProblem);
      if (problems.length > 1) {
        throw new ArcBootError(
          formatBootProblems(`Resource '${resourceName}' preset routes cannot boot`, problems),
          problems,
        );
      }
    },
  };
}
