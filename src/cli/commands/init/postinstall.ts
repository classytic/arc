/**
 * Package manager detection + post-scaffold installation.
 *
 * Detection priority: lockfile in cwd > globally-available command
 * (pnpm > yarn > bun > npm). The lockfile check honours whatever the
 * user already has in the parent directory — installing a project
 * alongside an existing pnpm monorepo should prefer pnpm even if the
 * user also has npm installed globally.
 */

import { execSync, spawn } from "node:child_process";
import { accessSync } from "node:fs";
import * as path from "node:path";
import type { PackageManager, ProjectConfig } from "./types.js";

/**
 * Detect which package manager to use.
 * Priority: pnpm > yarn > bun > npm (based on lockfile or global availability)
 */
export function detectPackageManager(): PackageManager {
  // Check for lockfiles in current directory (user preference)
  try {
    const cwd = process.cwd();
    if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
    if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
    if (existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  } catch {
    // Ignore errors
  }

  // Check which package managers are available
  if (isCommandAvailable("pnpm")) return "pnpm";
  if (isCommandAvailable("yarn")) return "yarn";
  if (isCommandAvailable("bun")) return "bun";

  // Default to npm
  return "npm";
}

/** Check if a command is available in PATH. */
function isCommandAvailable(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Sync check if file exists (ESM-compatible — no require()). */
function existsSync(filePath: string): boolean {
  try {
    accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install dependencies using the detected package manager.
 *
 * Dependencies are already declared in the generated `package.json` (see
 * `packageJsonTemplate`), so a single plain `install` resolves the full
 * tree. No two-pass `npm add` flow — the manifest is the source of truth.
 */
export async function installDependencies(
  projectPath: string,
  _config: ProjectConfig,
  pm: PackageManager,
): Promise<void> {
  console.log(`  Installing dependencies...`);
  await runCommand(getInstallCommand(pm), projectPath);
  console.log(`\nDependencies installed successfully.`);
}

/**
 * Get the plain `install` command for a package manager. Reads the declared
 * dependencies from the project's `package.json`.
 */
function getInstallCommand(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return "bun install";
    default:
      return "npm install";
  }
}

/** Run a shell command in a directory. */
function runCommand(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd" : "/bin/sh";
    const shellFlag = isWindows ? "/c" : "-c";

    const child = spawn(shell, [shellFlag, command], {
      cwd,
      stdio: "inherit",
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on("error", reject);
  });
}
