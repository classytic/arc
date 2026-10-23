/**
 * Observe whether a hook answered the request.
 *
 * `reply.sent` is false while async `preSerialization`/`onSend` hooks defer the write, so a
 * host-supplied hook that called `reply.code(...).send(...)` and resolved `undefined` looks
 * like it never answered — and Fastify then runs the handler. Wrapping `send` for the
 * duration of the call makes the refusal observable so the caller can return the reply.
 */

import type { FastifyReply } from "fastify";

/** Run `fn`, reporting whether it called `reply.send` (or the reply is already sent). */
export async function runObservingSend<T>(
  reply: FastifyReply,
  fn: () => T | Promise<T>,
): Promise<{ result: T; answered: boolean }> {
  let answered = false;
  const send = reply.send;
  reply.send = function trackedSend(this: FastifyReply, payload?: unknown): FastifyReply {
    answered = true;
    return send.call(this, payload);
  } as typeof reply.send;
  try {
    const result = await fn();
    return { result, answered: answered || reply.sent };
  } finally {
    reply.send = send;
  }
}
