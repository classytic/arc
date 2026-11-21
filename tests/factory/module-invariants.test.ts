/**
 * Module facts and invariants: evaluated once after composition planning and before any
 * module setup; every failure in ONE ArcBootError carrying code, module and fix.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ArcBootError,
  type ArcModuleInput,
  createApp,
  defineModule,
  planModules,
} from "../../src/factory/index.js";

async function boot(modules: ArcModuleInput[]) {
  const app = await createApp({ preset: "testing", auth: false, logger: false, modules });
  await app.ready();
  return app;
}

async function bootError(modules: ArcModuleInput[]): Promise<ArcBootError> {
  const err = await boot(modules).then(
    (app) => {
      void app.close();
      return undefined;
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ArcBootError);
  return err as ArcBootError;
}

/** The incident: a media module on a local disk driver turned its upload receiver off. */
function mediaModule(config: { driver: "local" | "s3"; uploadReceiver: boolean }) {
  return defineModule({
    name: "media",
    facts: { driver: config.driver, uploadReceiver: config.uploadReceiver },
    invariants: [
      {
        code: "media.upload-receiver",
        fix: "enable the upload receiver or use a cloud driver",
        check: (f) =>
          f.driver !== "local" || f.uploadReceiver || "local driver with the upload receiver off",
      },
    ],
  });
}

describe("module invariants", () => {
  it("fails boot on the incident's contradiction before the module sets anything up", async () => {
    const setup = vi.fn();
    const media = { ...mediaModule({ driver: "local", uploadReceiver: false }), plugins: setup };
    const err = await bootError([media]);
    expect(err.code).toBe("media.upload-receiver");
    expect(err.problems).toEqual([
      {
        code: "media.upload-receiver",
        module: "media",
        message: "local driver with the upload receiver off",
        fix: "enable the upload receiver or use a cloud driver",
      },
    ]);
    expect(err.message).toBe(
      [
        "[arc] module invariants failed — no module was set up (1 problem):",
        '  - [media.upload-receiver] module "media": local driver with the upload receiver off',
        "    fix: enable the upload receiver or use a cloud driver",
      ].join("\n"),
    );
    expect(setup).not.toHaveBeenCalled();
  });

  it("boots when every invariant passes", async () => {
    const app = await boot([mediaModule({ driver: "s3", uploadReceiver: false })]);
    await app.close();
  });

  it("collects every failure across modules into one error, then throws once", async () => {
    const plugins = vi.fn();
    const bootstrap = vi.fn();
    const err = await bootError([
      { ...mediaModule({ driver: "local", uploadReceiver: false }), plugins },
      defineModule({
        name: "mail",
        facts: { transport: "smtp", host: "" },
        invariants: [
          { code: "mail.host", fix: "set the SMTP host", check: (f) => f.host !== "" },
          { code: "mail.ok", fix: "n/a", check: () => true },
          {
            code: "mail.throws",
            fix: "fix the check",
            check: () => {
              throw new Error("boom");
            },
          },
        ],
        bootstrap,
      }),
    ]);
    expect(err.code).toBe("boot-failed");
    expect(err.problems.map((p) => [p.module, p.code, p.message])).toEqual([
      ["media", "media.upload-receiver", "local driver with the upload receiver off"],
      ["mail", "mail.host", "check returned false"],
      ["mail", "mail.throws", "check threw: boom"],
    ]);
    expect(err.message).toContain("(3 problems)");
    expect(plugins).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("reads another module's facts by name (cross-module contradiction)", async () => {
    const seen: unknown[] = [];
    const uploads = defineModule({
      name: "uploads",
      dependsOn: ["media"],
      invariants: [
        {
          code: "uploads.needs-receiver",
          fix: "turn the media upload receiver on",
          check: (_own, all) => {
            seen.push(all.media, all.absent);
            return all.media?.uploadReceiver === true || "media's upload receiver is off";
          },
        },
      ],
    });
    const err = await bootError([mediaModule({ driver: "s3", uploadReceiver: false }), uploads]);
    expect(err.problems).toEqual([
      expect.objectContaining({ code: "uploads.needs-receiver", module: "uploads" }),
    ]);
    expect(seen).toEqual([{ driver: "s3", uploadReceiver: false }, undefined]);
    expect(Object.isFrozen(seen[0])).toBe(true);

    const app = await boot([mediaModule({ driver: "s3", uploadReceiver: true }), uploads]);
    await app.close();
  });

  it("rejects non-serialisable facts and asynchronous checks", async () => {
    const err = await bootError([
      defineModule({ name: "a", facts: { at: new Date(0) } }),
      defineModule({
        name: "b",
        invariants: [
          {
            code: "b.async",
            fix: "make it synchronous",
            check: (() => Promise.resolve(true)) as never,
          },
        ],
      }),
    ]);
    expect(err.problems.map((p) => [p.code, p.message])).toEqual([
      ["module-facts-not-serialisable", "facts.at is not plain serialisable data"],
      ["b.async", "check returned a Promise — invariants must be synchronous"],
    ]);
  });

  it("is fatal under the production preset too, and planModules fails the same way", async () => {
    const media = mediaModule({ driver: "local", uploadReceiver: false });
    const err = await createApp({
      preset: "production",
      runtime: "memory",
      auth: false,
      logger: false,
      trustProxy: false,
      modules: [media],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArcBootError);
    await expect(planModules([media])).rejects.toThrow(/\[media\.upload-receiver\]/);
  });
});
