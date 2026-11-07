// Shared teardown helper for tests that point DATA_DIR at a temp directory.
//
// The DB driver keeps the SQLite file handle open for the lifetime of the
// process (node:sqlite DatabaseSync), and Windows refuses to delete a file
// that is still open — so `fs.rmSync(tempDir)` fails with EPERM and fails the
// whole test file. Release the adapter handle before removing the directory,
// and never let cleanup itself throw.
import fs from "node:fs";

/** Close the cached DB adapter (if any) so Windows can delete the data file. */
export function releaseDbAdapter() {
  const state = globalThis._dbAdapter;
  if (!state) return;
  try {
    state.instance?.close?.();
  } catch {
    // adapter already closed / never opened
  }
  state.instance = null;
  state.initPromise = null;
}

/** Best-effort removal of a temp directory. Never throws. */
export function removeTempDir(dir) {
  if (!dir) return;
  releaseDbAdapter();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Leftover handle — the OS temp dir gets cleaned up eventually.
  }
}
