/**
 * @classytic/arc/sync — re-export of the storage-agnostic change-log/cursor
 * contract from `@classytic/repo-core/sync` (the cross-kit contract home).
 * Kits implement capture + durable stores; arc modules expose the HTTP
 * surface (/sync/pull, /sync/push). See repo-core src/sync for semantics.
 */
export {
  type ChangeEntry,
  type ChangeLogAppendOptions,
  type ChangeLogStore,
  type ChangeOp,
  type ChangesPage,
  type ChangesSinceOptions,
  CursorExpiredError,
  MemoryChangeLogStore,
  type PushMutation,
  type PushVerdict,
  type PushVerdictStatus,
} from "@classytic/repo-core/sync";
