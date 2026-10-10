import type { EventHandler } from "./EventTransport.js";

const SUBSCRIBER_ID = Symbol.for("@classytic/arc/subscriber-id");

/** Assign a deployment-stable identity for durable per-handler progress; never use an index. */
export function withSubscriberId<T>(id: string, handler: EventHandler<T>): EventHandler<T> {
  if (typeof id !== "string" || !id.trim())
    throw new Error("[Arc Events] subscriber id must be non-empty");
  const wrapped: EventHandler<T> = async (event) => {
    await handler(event);
  };
  Object.defineProperty(wrapped, SUBSCRIBER_ID, { value: id });
  return wrapped;
}

export function getSubscriberId(handler: EventHandler<never>): string | undefined {
  const id: unknown = Reflect.get(handler, SUBSCRIBER_ID);
  return typeof id === "string" ? id : undefined;
}

/** Preserve explicit IDs and the implicit function name through framework wrappers. */
export function preserveSubscriberIdentity<T>(
  original: EventHandler<T>,
  wrapper: EventHandler<T>,
): EventHandler<T> {
  const id = getSubscriberId(original);
  if (id !== undefined) Object.defineProperty(wrapper, SUBSCRIBER_ID, { value: id });
  Object.defineProperty(wrapper, "name", { value: original.name, configurable: true });
  return wrapper;
}
