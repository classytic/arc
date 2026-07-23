/**
 * Logger doubles. `silentLogger` for tests that only need quiet;
 * `recordingLogger()` when the test asserts WHAT was logged.
 */

export interface TestLogEntry {
  level: "debug" | "info" | "warn" | "error";
  args: unknown[];
}

export const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function recordingLogger() {
  const entries: TestLogEntry[] = [];
  const push =
    (level: TestLogEntry["level"]) =>
    (...args: unknown[]) =>
      void entries.push({ level, args });
  return {
    entries,
    /** Messages (string args flattened) for `toContain`-style assertions. */
    messages: (level?: TestLogEntry["level"]) =>
      entries
        .filter((e) => !level || e.level === level)
        .flatMap((e) => e.args.filter((a): a is string => typeof a === "string")),
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}
