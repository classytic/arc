/**
 * vitest globalSetup: sweep `mongo-mem-*` data dirs abandoned by earlier killed
 * or crashed runs (dead `mongod.lock` pid AND untouched for
 * `TEST_MONGO_SWEEP_HOURS`, default 6). Most suites here call
 * `MongoMemoryServer.create()` directly, so this is what reclaims their dirs
 * when a run never reaches `stop()`. Runs in the background: a first sweep
 * after a long leak can have gigabytes to delete.
 */
import { sweepStaleMongoMemoryDirsOnce } from "../../src/testing/mongoMemoryTmp.js";

export function setup(): void {
  void sweepStaleMongoMemoryDirsOnce("arc-tests");
}
