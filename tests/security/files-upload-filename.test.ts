/**
 * Security Tests: Files Upload Filename Sanitisation
 *
 * Confirms the upload preset rejects filenames that could traverse or
 * confuse a storage adapter — path separators, NULs, `.`/`..`, or
 * names exceeding 255 chars. Storage adapters often compose
 * `${prefix}/${filename}` or `path.join(root, filename)`; the preset
 * ships the strict default so common adapters are safe out of the box.
 */

import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { FilenamePolicy } from "../../src/presets/filesUpload.js";
import { filesUploadPreset } from "../../src/presets/filesUpload.js";
import type { ResourcePermissions, RouteDefinition } from "../../src/types/index.js";
import type { Storage } from "../../src/types/storage.js";
import { ValidationError } from "../../src/utils/errors.js";

function getUploadHandler(sanitizeFilename?: FilenamePolicy): {
  handler: RouteHandlerMethod;
  upload: ReturnType<typeof vi.fn>;
} {
  const upload = vi.fn(async (input: { size: number; mimeType: string }) => ({
    id: "id-1",
    url: "memory://id-1",
    pathname: "id-1",
    contentType: input.mimeType,
    bytes: input.size,
  }));
  const storage: Storage = {
    upload,
    read: vi.fn(),
    delete: vi.fn(),
  } as unknown as Storage;

  const preset = filesUploadPreset({ storage, sanitizeFilename });
  const permissions: ResourcePermissions = {};
  const routes =
    typeof preset.routes === "function" ? preset.routes(permissions) : (preset.routes ?? []);
  const uploadRoute = (routes as RouteDefinition[]).find((r) => r.path === "/upload");
  if (!uploadRoute) throw new Error("upload route not produced by preset");
  return { handler: uploadRoute.handler as RouteHandlerMethod, upload };
}

function makeRequest(filename: string): FastifyRequest {
  return {
    id: "req-1",
    body: {
      _files: {
        file: {
          buffer: Buffer.from("payload"),
          filename,
          mimetype: "text/plain",
          size: 7,
        },
      },
    },
    headers: {},
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  const reply = {
    code: vi.fn(() => reply),
    send: vi.fn(() => reply),
  } as unknown as FastifyReply;
  return reply;
}

describe("Security: Files Upload filename sanitisation", () => {
  const dangerous: Array<[string, string]> = [
    ["../etc/passwd", "parent-directory traversal"],
    ["foo/bar.txt", "forward slash"],
    ["foo\\bar.txt", "backslash"],
    ["\0null.txt", "NUL byte"],
    [".", "single dot"],
    ["..", "double dot"],
    ["", "empty"],
    ["x".repeat(256), "length > 255"],
  ];

  for (const [name, label] of dangerous) {
    it(`rejects filename with ${label}`, async () => {
      const { handler, upload } = getUploadHandler();
      const req = makeRequest(name);
      const reply = makeReply();

      await expect(
        (handler as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>)(req, reply),
      ).rejects.toThrow(ValidationError);
      expect(upload).not.toHaveBeenCalled();
    });
  }

  it("accepts a safe filename and forwards it to storage", async () => {
    const { handler, upload } = getUploadHandler();
    const req = makeRequest("photo.jpg");
    const reply = makeReply();

    await (handler as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>)(req, reply);
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0] as unknown[])[0]).toMatchObject({ filename: "photo.jpg" });
  });
});

describe("filesUploadPreset: sanitizeFilename flexibility", () => {
  it.each<[FilenamePolicy, string]>([
    [false, "foo/bar.txt"],
    ["*", "foo/bar.txt"],
    [false, "../etc/passwd"],
    [false, ".."],
    [false, ""],
  ])("policy %s accepts previously-rejected name %s", async (policy, filename) => {
    const { handler, upload } = getUploadHandler(policy);
    const req = makeRequest(filename);
    const reply = makeReply();

    await (handler as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>)(req, reply);
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0] as unknown[])[0]).toMatchObject({ filename });
  });

  it("custom policy function can transform the filename", async () => {
    const policy: FilenamePolicy = (name) => name.toLowerCase().replace(/\s+/g, "-");
    const { handler, upload } = getUploadHandler(policy);
    const req = makeRequest("Vacation Photo.JPG");
    const reply = makeReply();

    await (handler as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>)(req, reply);
    expect((upload.mock.calls[0] as unknown[])[0]).toMatchObject({
      filename: "vacation-photo.jpg",
    });
  });

  it("custom policy function can reject via `false`", async () => {
    const policy: FilenamePolicy = (name) => !name.endsWith(".exe");
    const { handler, upload } = getUploadHandler(policy);
    const req = makeRequest("malware.exe");
    const reply = makeReply();

    await expect(
      (handler as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>)(req, reply),
    ).rejects.toThrow(ValidationError);
    expect(upload).not.toHaveBeenCalled();
  });

  it("custom policy can accept via `true`/void", async () => {
    const policy: FilenamePolicy = () => undefined;
    const { handler, upload } = getUploadHandler(policy);
    const req = makeRequest("foo/bar.txt");
    const reply = makeReply();

    await (handler as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>)(req, reply);
    expect((upload.mock.calls[0] as unknown[])[0]).toMatchObject({ filename: "foo/bar.txt" });
  });

  it("explicit policy `true` keeps strict default behavior", async () => {
    const { handler, upload } = getUploadHandler(true);
    const req = makeRequest("../etc/passwd");
    const reply = makeReply();

    await expect(
      (handler as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>)(req, reply),
    ).rejects.toThrow(ValidationError);
    expect(upload).not.toHaveBeenCalled();
  });
});
