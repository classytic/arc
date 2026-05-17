/**
 * Interactive option-gathering for `arc init`.
 *
 * Two modes:
 *   - Interactive: any unspecified option is prompted via readline.
 *   - Non-interactive: triggered when `options.name` is provided — every
 *     unspecified option falls to its sensible default. Used by tests and
 *     by scripted scaffolds.
 *
 * Side effect: prints a Mongoose-on-Workers compatibility warning when
 * the user selects `edge + mongokit`, and offers to switch to the
 * custom adapter. This is the one spot where the CLI nudges the user
 * away from a known-broken combo.
 */

import * as readline from "node:readline";
import type { InitOptions, ProjectConfig } from "./types.js";

export async function gatherConfig(options: InitOptions): Promise<ProjectConfig> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  // Non-interactive mode: if a project name was provided via args, skip prompts
  // and use defaults for any unspecified options
  const nonInteractive = !!options.name;

  try {
    // Project name
    const name = options.name || (await question("Project name: ")) || "my-arc-app";

    // Adapter choice
    let adapter: "mongokit" | "custom" = options.adapter || "mongokit";
    if (!options.adapter && !nonInteractive) {
      const adapterChoice = await question(
        "Database adapter [1=MongoKit (recommended), 2=Custom / Drizzle-ready]: ",
      );
      adapter = adapterChoice === "2" ? "custom" : "mongokit";
    }

    // Auth strategy
    let auth: "jwt" | "better-auth" = options.auth || "better-auth";
    if (!options.auth && !nonInteractive) {
      const authChoice = await question("Auth strategy [1=Better Auth (recommended), 2=Arc JWT]: ");
      auth = authChoice === "2" ? "jwt" : "better-auth";
    }

    // Better Auth–specific: session strategy + api-key plugin
    let session: "cookie" | "bearer" | "both" = options.session ?? "cookie";
    let apiKey = options.apiKey ?? false;
    if (auth === "better-auth" && !nonInteractive) {
      if (options.session === undefined) {
        const sessionChoice = await question(
          "Session strategy [1=Cookie (web app, default), 2=Bearer token (mobile/SPA), 3=Both]: ",
        );
        session = sessionChoice === "2" ? "bearer" : sessionChoice === "3" ? "both" : "cookie";
      }
      if (options.apiKey === undefined) {
        const apiKeyChoice = await question(
          "Enable API key plugin (machine-to-machine auth via @better-auth/api-key)? [y/N]: ",
        );
        apiKey = apiKeyChoice.toLowerCase() === "y";
      }
    }

    // Tenant mode
    let tenant: "multi" | "single" = options.tenant || "single";
    if (!options.tenant && !nonInteractive) {
      const tenantChoice = await question("Tenant mode [1=Single-tenant, 2=Multi-tenant]: ");
      tenant = tenantChoice === "2" ? "multi" : "single";
    }

    // TypeScript or JavaScript
    let typescript = options.typescript ?? true;
    if (options.typescript === undefined && !nonInteractive) {
      const tsChoice = await question("Language [1=TypeScript (recommended), 2=JavaScript]: ");
      typescript = tsChoice !== "2";
    }

    // Environment/Target choice
    let edge = options.edge ?? false;
    if (options.edge === undefined && !nonInteractive) {
      const edgeChoice = await question(
        "Deployment target [1=Node.js Server (default), 2=Edge/Serverless]: ",
      );
      edge = edgeChoice === "2";
    }

    // Docker scaffolding — opt-in (2.16). Frameworks don't dictate
    // deployment; hosts pick Cloud Run / Fly / Vercel / Lambda / their
    // own k8s manifests. We only emit Dockerfile / .dockerignore /
    // docker-compose.yml when explicitly requested via `--docker`.
    // `edge: true` overrides — Workers don't run in containers.
    let docker = (options.docker ?? false) && !edge;
    if (options.docker === undefined && !nonInteractive && !edge) {
      const dockerChoice = await question(
        "Include Docker (Dockerfile + compose.yml) for local dev? [y/N]: ",
      );
      docker = dockerChoice.toLowerCase() === "y";
    }

    // Warn about edge + database compatibility
    if (edge && adapter === "mongokit" && !nonInteractive) {
      console.log("");
      console.log("  ⚠ Edge + MongoKit: Mongoose does NOT work on Cloudflare Workers.");
      console.log(
        "    MongoDB Atlas works with the raw driver (mongodb 6.15+ with nodejs_compat_v2),",
      );
      console.log("    but MongoKit depends on Mongoose. Options:");
      console.log("    1. Use AWS Lambda / Vercel Serverless (Node.js) — Mongoose works normally");
      console.log(
        "    2. Use Cloudflare Hyperdrive + PostgreSQL (wire sqlitekit/Drizzle via custom adapter)",
      );
      console.log(
        "    3. Continue with MongoKit — works on Lambda/Vercel, NOT on Cloudflare Workers",
      );
      console.log("");
      const proceed = await question("Continue with MongoKit? [y/N]: ");
      if (proceed.toLowerCase() !== "y") {
        adapter = "custom";
        console.log(
          "  Switched to custom adapter. Wire sqlitekit/Drizzle, prismakit, or any RepositoryLike-conforming repo.",
        );
      }
    }

    return { name, adapter, auth, tenant, apiKey, session, typescript, edge, docker };
  } finally {
    rl.close();
  }
}
