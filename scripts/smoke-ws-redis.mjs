#!/usr/bin/env node
/**
 * Dual-mode smoke runner — boots a local Redis via docker-compose,
 * runs the WebSocket smoke test against it, then tears Redis down.
 *
 * Honors `ARC_WS_SMOKE_REDIS_URL` if already set (CI lanes that
 * provision Redis externally — skip the docker boot/teardown).
 *
 * Exit code is the vitest exit code so CI fails on test failures, not
 * on docker teardown errors.
 */
import { execSync, spawnSync } from "node:child_process";

const COMPOSE_FILE = "docker-compose.smoke.yml";
const DEFAULT_URL = "redis://localhost:6390";

const externalUrl = process.env.ARC_WS_SMOKE_REDIS_URL;
const boot = !externalUrl;

if (boot) {
  console.log("[smoke-ws-redis] booting local Redis via docker compose…");
  try {
    execSync(`docker compose -f ${COMPOSE_FILE} up -d --wait`, { stdio: "inherit" });
  } catch (err) {
    console.error(
      "[smoke-ws-redis] docker compose up failed. Install Docker, or set " +
        "ARC_WS_SMOKE_REDIS_URL to point at an existing Redis instance.",
    );
    process.exit(2);
  }
}

const url = externalUrl ?? DEFAULT_URL;
console.log(`[smoke-ws-redis] running against ${url}`);

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vitest", "run", "tests/integrations/websocket/smoke.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, ARC_WS_SMOKE_REDIS_URL: url },
  },
);

if (boot) {
  console.log("[smoke-ws-redis] tearing down local Redis…");
  try {
    execSync(`docker compose -f ${COMPOSE_FILE} down`, { stdio: "inherit" });
  } catch {
    // Teardown failure should NOT mask a test failure — keep going.
  }
}

process.exit(result.status ?? 1);
