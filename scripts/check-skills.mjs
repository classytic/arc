/**
 * Skills gate: the agent-facing skills (skills/**, llms.txt) must stay small, current and true.
 *
 * Checks (docs/plan/14-skill-standard.md):
 *   1. size    : SKILL.md body <= 6 KB, description <= 400 chars, each reference <= 8 KB, llms.txt <= 3 KB
 *   2. shape   : SKILL.md has name/description/metadata.minVersion and the five standard sections;
 *                every reference file is linked from its SKILL.md
 *   3. clean   : no legacy/deprecated/formerly/backward-compat wording, no version-by-version notes,
 *                no em-dashes, no emojis
 *   4. verified: every `@classytic/arc[/subpath]` specifier resolves in package.json `exports`; every
 *                name imported from one exists in api-surface.json (run `npm run api:surface` after
 *                a build); every `name()` token on a line that names an arc subpath is an arc
 *                export or listed in scripts/skill-check-external.json; names in llms.txt appear in the arc skill
 *
 * Exported for tests/skills/skills.test.ts. Zero deps.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BUDGET = {
  skillBodyBytes: 6 * 1024,
  descriptionChars: 400,
  referenceBytes: 8 * 1024,
  llmsBytes: 3 * 1024,
};

const SECTIONS = ["Do not hand-roll", "Golden path", "Gotchas", "Never", "References"];

const BANNED = [
  [/\bdeprecated\b/i, "deprecated"],
  [/\blegacy\b/i, "legacy"],
  [/\bformerly\b/i, "formerly"],
  [/backward[- ]?compat/i, "backward compat"],
  [/\bno longer\b/i, "no longer"],
  [/\bused to\b/i, "used to"],
  [/\bold way\b/i, "old way"],
  [/\bremoved in\b/i, "removed in"],
  [/\bpre-\d+\.\d+/i, "pre-X.Y"],
  [/\bsince \d+\.\d+/i, "since X.Y"],
  [/\(\d+\.\d+(\.\d+)?\+?\)/, "(X.Y) version tag"],
  [/\b(added|new|changed|fixed) in \d+\.\d+/i, "added/changed in X.Y"],
  [/—/, "em-dash"],
  [/[\u{1F300}-\u{1FAFF}✅❌⚠✨⭐✔✖]/u, "emoji"],
];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return m ? { raw: m[1], body: text.slice(m[0].length) } : { raw: "", body: text };
}

function description(raw) {
  const m = /^description:\s*(\|[-+]?\s*\n((?:[ \t]+.*\n?)+)|>[-+]?\s*\n((?:[ \t]+.*\n?)+)|.*)/m.exec(raw);
  if (!m) return "";
  const block = m[2] ?? m[3];
  if (block) return block.replace(/\s+/g, " ").trim();
  return m[1].replace(/^["']|["']$/g, "").trim();
}

/** `@classytic/arc/permissions` -> `./permissions`; `@classytic/arc` -> `.`; other packages -> null. */
function subpathOf(spec) {
  if (spec === "@classytic/arc") return ".";
  return spec.startsWith("@classytic/arc/") ? `./${spec.slice("@classytic/arc/".length)}` : null;
}

export function checkSkills(root = resolve(fileURLToPath(new URL("..", import.meta.url)))) {
  const failures = [];
  const fail = (file, msg) => failures.push(`${relative(root, file).split(sep).join("/")}: ${msg}`);

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const surface = JSON.parse(readFileSync(join(root, "api-surface.json"), "utf8"));
  const externalFile = join(root, "scripts", "skill-check-external.json");
  const external = new Set(existsSync(externalFile) ? JSON.parse(readFileSync(externalFile, "utf8")) : []);
  const allExports = new Set();
  for (const entry of Object.values(surface)) {
    for (const n of [...(entry.runtime ?? []), ...(entry.types ?? [])]) allExports.add(n);
  }
  const subpathExports = (sub) => {
    const e = surface[sub];
    return e ? new Set([...(e.runtime ?? []), ...(e.types ?? [])]) : null;
  };

  const skillsDir = join(root, "skills");
  const files = existsSync(skillsDir) ? walk(skillsDir).filter((f) => f.endsWith(".md")) : [];
  const llms = join(root, "llms.txt");
  const texts = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  if (existsSync(llms)) texts.set(llms, readFileSync(llms, "utf8"));

  for (const [file, text] of texts) {
    const isSkill = file.endsWith(`${sep}SKILL.md`);
    const isRef = file.includes(`${sep}references${sep}`);
    const bytes = Buffer.byteLength(text);

    // 1. size
    if (file === llms && bytes > BUDGET.llmsBytes) fail(file, `${bytes} B exceeds llms.txt budget ${BUDGET.llmsBytes} B`);
    if (isRef && bytes > BUDGET.referenceBytes) fail(file, `${bytes} B exceeds reference budget ${BUDGET.referenceBytes} B (split by topic)`);
    if (isSkill) {
      const { raw, body } = frontmatter(text);
      const bodyBytes = Buffer.byteLength(body);
      if (bodyBytes > BUDGET.skillBodyBytes) fail(file, `body ${bodyBytes} B exceeds ${BUDGET.skillBodyBytes} B (move detail to references/)`);
      const desc = description(raw);
      if (!desc) fail(file, "frontmatter needs a description");
      else if (desc.length > BUDGET.descriptionChars) fail(file, `description ${desc.length} chars exceeds ${BUDGET.descriptionChars}`);
      if (!/^name:\s*\S+/m.test(raw)) fail(file, "frontmatter needs name");
      if (!/minVersion:\s*\S+/.test(raw)) fail(file, "frontmatter needs metadata.minVersion");

      // 2. shape
      for (const section of SECTIONS) {
        if (!new RegExp(`^#{2,3}\\s+.*${section}`, "mi").test(body)) fail(file, `missing section "${section}"`);
      }
      const refDir = join(file, "..", "references");
      if (existsSync(refDir)) {
        for (const ref of readdirSync(refDir).filter((n) => n.endsWith(".md"))) {
          if (!text.includes(`references/${ref}`)) fail(file, `references/${ref} is not linked`);
        }
      }
    }

    // 3. clean
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [re, label] of BANNED) {
        if (re.test(line)) fail(file, `line ${i + 1}: banned "${label}": ${line.trim().slice(0, 80)}`);
      }
    });

    // 4. verified
    for (const m of text.matchAll(/@classytic\/arc(?:\/[A-Za-z0-9._/-]+)?/g)) {
      const sub = subpathOf(m[0].replace(/[./-]+$/, ""));
      if (sub && !(sub in (pkg.exports ?? {}))) fail(file, `unknown subpath ${m[0]}`);
    }
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](@classytic\/arc[^'"]*)['"]/g)) {
      const sub = subpathOf(m[2]);
      const names = sub ? subpathExports(sub) : null;
      if (!names) {
        if (sub) fail(file, `import from ${m[2]}: subpath has no api-surface entry`);
        continue;
      }
      const clause = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const part of clause.split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name && !names.has(name)) fail(file, `${name} is not exported by ${m[2]}`);
      }
    }
    // Call-form tokens on a line that also names an arc subpath (the "do not hand-roll" rows) must exist.
    for (const line of lines.filter((l) => l.includes("@classytic/arc"))) {
      for (const m of line.matchAll(/`([A-Za-z_$][\w$]*)\(\)`/g)) {
        if (!allExports.has(m[1]) && !external.has(m[1])) {
          fail(file, `\`${m[1]}()\` is not an arc export (other packages: scripts/skill-check-external.json)`);
        }
      }
    }
  }

  // llms.txt and the arc skill agree: every arc export named in llms.txt appears in the arc skill.
  if (texts.has(llms)) {
    const arcSkill = [...texts].filter(([f]) => f.includes(`${sep}skills${sep}arc${sep}`)).map(([, t]) => t).join("\n");
    for (const m of texts.get(llms).matchAll(/\b([A-Za-z_$][\w$]*)\(\)/g)) {
      if (allExports.has(m[1]) && !arcSkill.includes(m[1])) fail(llms, `${m[1]} is not in skills/arc`);
    }
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkSkills();
  if (failures.length > 0) {
    console.error(`[check-skills] ${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("[check-skills] OK: skills and llms.txt within budget, clean, and every identifier exists");
}
