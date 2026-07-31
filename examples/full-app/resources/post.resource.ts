/**
 * Post Resource
 *
 * Public-readable, owner-writable posts.
 * Demonstrates: requireOwnership with a role bypass, custom actions, field rules.
 */

import mongoose from "mongoose";
import { defineResource } from "../../../src/core/index.js";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import {
  allowPublic,
  requireAuth,
  requireOwnership,
  requireRoles,
} from "../../../src/permissions/index.js";
import { Repository } from "@classytic/mongokit";
import { NotFoundError } from "../../../src/utils/errors.js";

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

  // Audit only deletes (skip noisy creates/updates for posts)
  audit: { operations: ["delete"] },

  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireAuth(),
    // Ownership as a PERMISSION, not the `ownedByUser` middleware preset: only
    // this form expresses "the owner, or an admin". The preset bypasses for
    // elevated platform scope alone, and its default `ownerField` is `userId`
    // — naming this schema's `createdBy` is required either way, since a
    // mismatched field makes every record look unowned, and unowned is denied.
    update: requireOwnership("createdBy", { bypassRoles: ["admin"] }),
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
      permissions: requireAuth(),
      summary: "Publish a draft post",
      rawHandler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const post = await PostModel.findByIdAndUpdate(
          id,
          { status: "published" },
          { new: true },
        ).lean();
        if (!post) throw new NotFoundError("Post", id);
        return reply.send(post);
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
