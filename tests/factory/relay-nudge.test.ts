/**
 * `withRelayNudge` — the merge that makes `dispatch: 'relay'` fast, and refuses
 * to let it be silently slow.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRelayNudge, withRelayNudge } from "../../src/factory/module/relay-nudge.js";

describe('withRelayNudge', () => {
  it('leaves an inline (or undeclared) runtime untouched', () => {
    const inline = { dispatch: 'inline', outbox: 'x' };
    expect(withRelayNudge('test', inline, { requestDrain: vi.fn() })).toBe(inline);
    const none = { outbox: 'x' };
    expect(withRelayNudge('test', none, undefined)).toBe(none);
  });

  it("under 'relay', afterCommit nudges the relay", () => {
    const requestDrain = vi.fn();
    const out = withRelayNudge('test', { dispatch: 'relay', outbox: 'x' }, { requestDrain }) as {
      afterCommit: (i: unknown) => void;
      outbox: string;
    };
    out.afterCommit({ events: [] });
    expect(requestDrain).toHaveBeenCalledTimes(1);
    expect(out.outbox).toBe('x'); // every other key survives the merge
  });

  it('resolves a THUNK at call time — the outbox module boots before this fires', () => {
    const requestDrain = vi.fn();
    const relay = vi.fn(() => ({ requestDrain }));
    const out = withRelayNudge('test', { dispatch: 'relay' }, relay) as { afterCommit: (i: unknown) => void };
    expect(relay).not.toHaveBeenCalled();
    out.afterCommit({});
    expect(requestDrain).toHaveBeenCalledTimes(1);
  });

  it("keeps the host's own afterCommit, running it first", () => {
    const order: string[] = [];
    const out = withRelayNudge('test', 
      { dispatch: 'relay', afterCommit: () => void order.push('host') },
      { requestDrain: () => void order.push('nudge') },
    ) as { afterCommit: (i: unknown) => void };
    out.afterCommit({});
    expect(order).toEqual(['host', 'nudge']);
  });

  it("still nudges when the host's afterCommit throws — the events are committed either way", () => {
    const requestDrain = vi.fn();
    const out = withRelayNudge('test',
      { dispatch: 'relay', afterCommit: () => { throw new Error('host hook'); } },
      { requestDrain },
    ) as { afterCommit: (i: unknown) => void };
    expect(() => out.afterCommit({})).toThrow('host hook');
    expect(requestDrain).toHaveBeenCalledTimes(1);
  });

  it("REFUSES 'relay' with no relay given — a forgotten wire must not be a silent 5 s", () => {
    expect(() => withRelayNudge('test', { dispatch: 'relay' }, undefined)).toThrow(/relay/);
  });

  it("'external' declares a worker-drained outbox and adds nothing", () => {
    const rt = { dispatch: 'relay' };
    expect(withRelayNudge('test', rt, 'external')).toBe(rt);
  });

  it('REFUSES the unresolved `{ fromModule }` form — createRelayNudge resolves it, not this', () => {
    // Reaching here with it unresolved would mean the module registry lookup
    // never ran, and a nudge that silently did nothing is a 5 s delivery delay.
    expect(() => withRelayNudge('test', { dispatch: 'relay' }, { fromModule: 'outbox' })).toThrow(/fromModule/);
  });

  it('does not fabricate a runtime from a non-object', () => {
    expect(withRelayNudge('test', undefined, 'external')).toBeUndefined();
  });
});

describe('createRelayNudge', () => {
  it('a direct relay needs no registry step', () => {
    const requestDrain = vi.fn();
    const nudge = createRelayNudge('test', { requestDrain });
    expect(nudge.afterResources).toBeUndefined();
    (nudge.apply({ dispatch: 'relay' }) as { afterCommit: (i: unknown) => void }).afterCommit({});
    expect(requestDrain).toHaveBeenCalledTimes(1);
  });

  it('{ fromModule } refuses to nudge before afterResources resolved the drain', () => {
    const nudge = createRelayNudge('test', { fromModule: 'outbox' });
    expect(nudge.afterResources).toBeTypeOf('function');
    const rt = nudge.apply({ dispatch: 'relay' }) as { afterCommit: (i: unknown) => void };
    expect(() => rt.afterCommit({})).toThrow(/not resolved yet/);
  });
});

