/**
 * Normalize raw argv tokens so that `--key=value` is split into
 * `['--key', 'value']` before the main switch runs.
 * This lets users write either `--name my-app` or `--name=my-app`.
 */
export function normalizeArgs(raw: string[]): string[] {
  const out: string[] = [];
  for (const arg of raw) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      out.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
    } else {
      out.push(arg);
    }
  }
  return out;
}
