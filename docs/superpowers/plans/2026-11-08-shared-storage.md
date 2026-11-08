# Shared local storage implementation plan

> Use executing-plans to implement and verify each task, then request a fresh review.

**Goal:** All browsers and Vite dev/preview processes share project-local SQLite data.
**Architecture:** Vite local API → SQLite transactional repository; browser data facade preserves existing page interfaces. Browser migration reads original IndexedDB only when explicitly requested.
**Stack:** Vue, Vite, Node built-in SQLite, existing domain validation.
**Spec:** apps/procurement-admin/STORAGE-DESIGN.md (approved).

## Constraints and review focus

- No standalone service, silent fallback, startup reset, or alteration of original IndexedDB.
- Fixed project-relative .data path, configurable explicit isolated test directory.
- Preserve existing codes, attachments and history during migration; preview conflicts and recheck atomically at import.
- Per-operation server validation, transaction/unique constraints, stale revision checks.
- Dev and preview must share data safely across processes, not just across tabs.

## Tasks

- [x] 1. Extract common Supplier/seeds/wire types to src/storage-model.ts. Add server/store.ts using DatabaseSync, unique IDs/codes/names, transactions, persistent counters and binary attachments. Add tests-unit/store.test.ts first: shared handles, restart, import 202611080007 and attachments, conflict rollback, corrupt-file failure, normal business invariants.
- [x] 2. Add server/plugin.ts with typed HTTP routes, entry validation, same-origin writes, binary serialization and error responses; register both Vite hooks with lazy storage initialization. Replace src/data.ts with fetch facade, retaining UI functions.
- [x] 3. Add src/legacy-storage.ts and Migration.vue: explicit v6 IndexedDB read without upgrades, import preview including conflicts, import only after confirmation. Keep original data. Add navigation/route and shared-reset warning.
- [x] 4. Make E2E records unique per run and avoid modifying pre-existing user records. Replace obsolete storage browser tests with shared-server/migration tests using explicit temp directories. Layout tests also use temp data; defaults remain shared.
- [x] 5. Build, domain/repository tests, real CLI E2E twice on same explicit test database, cross-context/cross-process dev+preview persistence tests, migration UI and attachments. Fresh review, fixes and README with one-time original-browser migration steps.

## Execution ledger

- Approved SQLite storage path and shared default E2E. Existing database source is original browser; current tool browser has no original page, so migration will require user to use the new UI in that browser.

### Implementation progress

- Repository tests RED→GREEN: two SQLite handles share updates, restart retains codes/files, original 202611080007 imports idempotently, conflicting imports roll back, corrupt database fails.
- Added preview fingerprint RED→GREEN: shared edits after migration preview refuse overwrite.
- Vite dev/preview both serve API, binary attachments stored in SQLite, data facade uses fetch exclusively. New migration route reads original v6 IDB readonly and leaves it intact.
- Browser storage test passed: original-browser migration UI + repeated import, separate contexts on dev/preview, file download bytes, concurrent writes from two processes, preview restart, invalid-input and cross-origin rejection.
- E2E helpers now create owned fixtures and unique names; AI test also uses owned draft. First validation exposed E2E env filtering: added inheritEnv for PROCUREMENT_DATA_DIR and startup assertion of actual directory. Earlier two runs wrote owned test records to default shared file; no reset, old IDB untouched. Subsequently inspected their exact IDs/titles/update timestamps, backed up the default SQLite with VACUUM INTO, and removed only the 12 confirmed validation requests plus their unreferenced owned suppliers; no seed records or counters were removed. Backup remains under .data/backups/validation-1794140192360.sqlite.
- Validation uses explicit temp directories. Default .data remains shared as user requested. Layout evidence now goes under .e2e/ui/shared-storage to avoid overwriting tracked baseline screenshots.
- Full E2E passed twice against the same asserted temp directory; README updated with default sharing, explicit isolation and original-browser migration instructions.
- Fresh review found one Important: imports retaining equal revision could allow old editors to overwrite imported changes. RED→GREEN regression fixes replacement revision to max(shared, source)+1; repeated identical imports ignore revision-only differences and remain idempotent. Tests cover lower/equal/higher source revision.
- Final verification: build/typecheck; 10 unit tests; migration UI + two contexts + dev/preview concurrency/restart and binary download; responsive six-page checks at 1440/768/375. No live AI model run, no PR/push.
- Original user's browser is not connected to available devtools (only about:blank). Production old data was not read or migrated automatically; final instructions require one explicit import in the original browser. The migration test uses a real v6 IndexedDB fixture containing 202611080007 and original bytes, not a mock API.
