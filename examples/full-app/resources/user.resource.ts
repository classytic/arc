/**
 * User Resource
 *
 * Admin-managed users with soft delete.
 * Demonstrates: presets, permissions, schema options, hooks.
 */

import mongoose from "mongoose";
import { defineResource } from "../../../src/core/index.js";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { allowPublic, requireRoles } from "../../../src/permissions/index.js";
import { Repository } from "@classytic/mongokit";

// Schema
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    role: { type: String, enum: ["admin", "editor", "viewer"], default: "viewer" },
    bio: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 });
userSchema.index({ role: 1 });

export const UserModel = mongoose.model("ExUser", userSchema);
const userRepository = new Repository(UserModel);

// Resource
export default defineResource({
  name: "user",
  displayName: "Users",

  adapter: createMongooseAdapter(UserModel, userRepository),

  presets: ["softDelete"],

  // Per-resource audit opt-in — fires only when auditPlugin is registered
  // with `autoAudit: { perResource: true }`. No exclude list needed.
  audit: true,

  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(["admin"]),
    update: requireRoles(["admin"]),
    delete: requireRoles(["admin"]),
  },

  schemaOptions: {
    fieldRules: {
      name: { type: "string", required: true },
      email: { type: "string", required: true },
      role: { type: "string" },
      bio: { type: "string" },
    },
  },

  hooks: {
    beforeCreate: async (ctx) => {
      // Normalize email
      if (ctx.data?.email) {
        ctx.data.email = (ctx.data.email as string).toLowerCase().trim();
      }
    },
  },

  events: {
    created: { description: "User registered" },
    updated: { description: "User profile updated" },
    deleted: { description: "User soft-deleted" },
  },
});
