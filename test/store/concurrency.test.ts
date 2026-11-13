import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eisen-conc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The TUI and the CLI share one DB file: opening and writing at the same time
// must neither fail nor apply a migration twice.
test(
  "several processes open a fresh DB and write at the same time",
  async () => {
    const path = join(dir, "eisen.db");
    const writers = 4;
    const perWriter = 25;
    const procs = Array.from({ length: writers }, (_, i) =>
      Bun.spawn([process.execPath, join(import.meta.dir, "writer.ts"), path, `w${i}`, String(perWriter)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })),
    );
    expect(results.filter((r) => r.code !== 0)).toEqual([]);
    const db = openDb(path);
    expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: writers * perWriter });
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: writers * perWriter });
    db.close();
  },
  30_000,
);
