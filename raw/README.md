# raw/

Immutable source documents. **Never edit anything in this folder.**

Drop in PDFs, RFCs, spec docs, incident post-mortems, meeting notes, screenshots, design docs — whatever the agent should reference.

When you ask Claude to ingest a source placed here, it will:
1. Read the file.
2. Discuss takeaways with you.
3. Write a summary page in `../wiki/`.
4. Create/update concept pages.
5. Link pages via `[[wiki-links]]`.
6. Update `../wiki/index.md` and append to `../wiki/log.md`.

A single source may touch 10-15 wiki pages. That is expected.

To cite a raw source from a wiki page, use: `(raw: filename.pdf)`.
