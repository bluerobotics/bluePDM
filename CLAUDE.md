# BluePLM — Project Context

Electron + React + TypeScript PDM application for SOLIDWORKS, backed by Supabase and a Fastify
API. The renderer lives in `src/`, the Electron main process in `electron/`, the REST API in
`api/`, the database schema in `supabase/`, and the SOLIDWORKS interop service in
`solidworks-service/`.

## Active plan

Nothing in flight. 4.3.3 shipped (renderer only — no schema change, no API change): when a
file's local path diverges from the path the vault records, the merge used to drop the server
row entirely, so a folder renamed on one machine looked *empty* to everyone else. It now leaves
a `moved_away` stub at the recorded path naming where the content actually lives
(`src/hooks/useLoadFiles/cloudFileReconciliation.ts`), and the pending-move count that was
always computed but never rendered is visible on the tree row, file row, and grid card. A new
`adopt-server-paths` command (server wins) is the inverse of the terminal-only
`reconcile-moved-paths` (local wins), and a **Resolve Pending Moves** dialog puts both
directions behind a badge and context menu with per-direction preflight. The rest of the
release fixed call sites that assumed a row with `pdmData` has local content, or that a
`files.id` maps to exactly one row — `moved_away` is the first status where neither holds.
Plan and four agent reports: `.cursor/plans/pending-move-visibility-*`.

`syncFile`'s primary existence check stays byte-exact and off `get_active_file_by_path` on
purpose — that was a deliberate scope decision for 4.3.1, not an oversight, and paying for a
case-insensitive lookup on every file during a bulk first check-in would slow down the path that
never collides.

**Closed, do not reopen without new evidence:** cleaning up "orphaned" `files` rows from the
pre-4.3.0 move handling. The diagnosis was finally run against production and the premise did
not survive it — the 1,324 rows its `superseded_high_confidence` bucket flagged in `br-vault`
are archive snapshots, revision branches, design variants, release copies, RFQ packages and
vendored firmware trees, all backed by files really on disk, and its survivor rule would have
kept `_ARCHIVE` over live `DEVELOPMENT`. Content hashing cannot distinguish a stale row from
intentional duplication, which a CAD vault is full of. Path divergence is only detectable where
the disk is visible, which is the client — that is what 4.3.3's `moved` / `moved_away` handling
now does. Full verdict and the disproof at the top of
`.cursor/plans/orphaned-file-rows-report.md`; read-only queries to reproduce in
`.cursor/plans/orphaned-file-rows-runbook.sql`.

Plans and agent reports live in `.cursor/plans/`. Never create a plan outside the repository.

## Commands

```bash
npm run typecheck      # renderer + electron; must pass before any tag
npm run typecheck:api  # api/ only
npm run test           # vitest run
npm run lint           # eslint
npm run dev            # vite dev server
npm run gen:types      # regenerate src/types/supabase.ts (requires the schema applied)
```

## Rules

The authoritative conventions are the Cursor rule files, imported here so they load
automatically:

@.cursor/rules/always.mdc
@.cursor/rules/architecture.mdc
@.cursor/rules/style.mdc
@.cursor/rules/react.mdc
@.cursor/rules/zustand.mdc
@.cursor/rules/database.mdc
@.cursor/rules/electron.mdc
@.cursor/rules/solidworks-service.mdc
@.cursor/rules/plans.mdc

The points that most often get violated:

- **Schema changes require two files.** Bump `schema_release_version()` in `supabase/core.sql`
  *and* `EXPECTED_SCHEMA_VERSION` in `src/lib/schemaVersion.ts`, and register new objects in
  `schema_release_manifest()`. There are no migration files — `supabase/core.sql` and
  `supabase/modules/*.sql` are edited in place and must stay idempotent. Never write
  `schema_version` directly and never push SQL from a terminal command; the user applies it in
  the Supabase SQL editor.
- **API changes require two files.** Bump `version` in `api/package.json` and
  `EXPECTED_API_VERSION` in `src/lib/apiVersion.ts`, with an `API_VERSION_DESCRIPTIONS` entry.
- **State goes in `usePDMStore` slices.** Never create a new Zustand store.
- **No `console.log`** in production code — use `log.*` (Pino in the API).
- **No hardcoded user-facing strings** — use `t()` from `src/lib/i18n`, and add new keys to every
  locale in `src/lib/i18n/locales/`; `newKeys.test.ts` enforces this.
- **No `any`.** Canonical domain types live in `src/types/`; `src/types/supabase.ts` is generated
  and must not be hand-edited.
- **Move, rename, and delete files with real filesystem operations**, never by writing a new file
  and deleting the old one.
- Files over 1,000 lines should be split; over 1,500 lines must be split before adding to them.
