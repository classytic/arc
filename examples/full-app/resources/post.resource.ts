/**
 * Post Resource
 *
 * Public-readable, owner-writable posts.
 * Demonstrates: ownedByUser preset, custom actions, field rules.
 */

import mongoose from "mongoose";
import { defineResource } from "../../../src/core/index.js";
import { createMongooseAdapter } from "../../../src/adapters/index.js";
import { allowPublic, requireAuth, requireRoles } from "../../../src/permissions/index.js";
import { Repository } from "@classytic/mongokit";

// Schema
const postSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
    tags: [{ type: String }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "ExUser" },
  },
  { timestamps: true },
);

postSchema.index({ status: 1, createdAt: -1 });
postSchema.index({ createdBy: 1 });

export const PostModel = mongoose.model("ExPost", postSchema);
const postRepository = new Repository(PostModel);

// Resource
export default defineResource({
  name: "post",
  displayName: "Posts",

  adapter: createMongooseAdapter(PostModel, postRepository),

  presets: ["ownedByUser"],

  // Audit only deletes (skip noisy creates/updates for posts)
  audit: { operations: ["delete"] },

  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireAuth(),
    update: requireAuth(), // ownedByUser preset enforces ownership
    delete: requireRoles(["admin"]),
  },

  schemaOptions: {
    fieldRules: {
      title: { type: "string", required: true },
      body: { type: "string", required: true },
      status: { type: "string" },
      tags: { type: "array" },
    },
    filterableFields: ["status", "createdBy"],
    sortableFields: ["createdAt", "title"],
  },

  routes: [
    {
      method: "POST",
      path: "/:id/publish",
      raw: true,
      permissions: requireAuth(),
      summary: "Publish a draft post",
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const post = await PostModel.findByIdAndUpdate(
          id,
          { status: "published" },
          { new: true },
        ).lean();
        if (!post) return reply.code(404).send({ success: false, error: "Post not found" });
        return reply.send({ success: true, data: post });
      },
    },
  ],

  hooks: {
    beforeCreate: async (ctx) => {
      // Auto-set createdBy from authenticated user
      if (ctx.user) {
        ctx.data.createdBy = ctx.user._id ?? ctx.user.id;
      }
    },
  },

  events: {
    created: { description: "Post created" },
    published: { description: "Post published" },
  },
});
