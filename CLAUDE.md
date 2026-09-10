# BluePLM — Project Context

Electron + React + TypeScript PDM application for SOLIDWORKS, backed by Supabase and a Fastify
API. The renderer lives in `src/`, the Electron main process in `electron/`, the REST API in
`api/`, the database schema in `supabase/`, and the SOLIDWORKS interop service in
`solidworks-service/`.

## Active plan

Nothing in flight. 4.3.2 (schema 101) shipped: a new main-process handler
(`electron/handlers/emptyDirs.ts`, `fs:trash-empty-dirs`) recycles a directory only after
re-confirming with an unfiltered `readdirSync` that it is provably empty, deepest-first, with no
permanent-delete fallback on any path; `discard-orphaned` derives the directories a batch of file
removals just emptied and recycles them inside the existing 4.3.1 blast-radius guard, cooldown,
and re-entrancy guard, relocating the current folder to its nearest surviving ancestor if the one
being viewed was removed; `folders` gained `REPLICA IDENTITY FULL` and joined the
`supabase_realtime` publication so a folder deleted while it held no files reaches other machines
too (previously it produced no realtime event at all), driven by a new `subscribeToFolders`
client subscription; and `canSkipMerge` (now `shouldSkipMerge` in `loadFilesCoordination.ts`)
gained the folder-side signal it was missing, so the merge that subscription schedules actually
runs instead of being short-circuited by three inputs a folder-only change never moves.

`syncFile`'s primary existence check stays byte-exact and off `get_active_file_by_path` on
purpose — that was a deliberate scope decision for 4.3.1, not an oversight, and paying for a
case-insensitive lookup on every file during a bulk first check-in would slow down the path that
never collides. Still deferred: cleaning up the orphaned `files` rows left by the pre-4.3.0 move
handling, which is diagnosis-only so far (`.cursor/plans/orphaned-file-rows-report.md`) — the
superseded-row bucket has a server-verifiable remediation candidate, the genuinely-orphaned
bucket does not, and neither has shipped.

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
