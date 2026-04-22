# Arc Wiki

Interlinked knowledge base for `@classytic/arc`. Agents read/update this instead of re-reading src.

## Layout

```
raw/    -- immutable source docs (RFCs, spec PDFs, incident notes). NEVER edit.
wiki/   -- concept pages maintained by Claude. One concept per file.
wiki/index.md -- table of contents with one-line descriptions.
wiki/log.md   -- append-only change record.
```

## When to read

- Answering architectural/design questions → [index.md](index.md), jump to relevant page.
- Making a code change → read the page for the module(s) touched.
- `wiki/` is complementary to [../CLAUDE.md](../CLAUDE.md) (quick ref) and [../AGENTS.md](../AGENTS.md) (deep guide). Wiki pages are concept-focused and stable across conversations.

## When to update

Whenever you change code in a way that invalidates a wiki page, or discover a non-obvious fact worth saving:

1. Edit the relevant concept page (or create a new one if no page fits).
2. Update [index.md](index.md) if adding/renaming/removing a page.
3. Append one line to [log.md](log.md): `YYYY-MM-DD — <page> — <what changed>`.
4. Keep pages short. Link via `[[page-name]]` instead of duplicating content.

## Page format

```markdown
# Title

**Summary**: one or two sentences.
**Sources**: src paths or raw/<file>.
**Last updated**: YYYY-MM-DD.

---

Content. Link with [[other-page]].

## Related
- [[other-page]]
```

## Rules

- Never modify `raw/`.
- Page names: lowercase, hyphen-separated (`request-scope.md`).
- Cite source files for non-obvious claims: `(src/permissions/core.ts)`.
- If two sources disagree, flag the contradiction. If unverified, mark it.
- No bloat. If a sentence repeats CLAUDE.md verbatim, link to CLAUDE.md instead.
