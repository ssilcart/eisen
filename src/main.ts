#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { runCli } from "./cli/cli.ts";

const args = Bun.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

if (args.length === 0) {
  // S9: no arguments opens the matrix. Loaded lazily so CLI commands never
  // pay for OpenTUI's native library.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("eisen: the matrix needs a terminal (see `eisen --help` for commands)\n");
    process.exit(1);
  }
  const { openDb, resolveDbPath } = await import("./store/db.ts");
  const { TaskRepository } = await import("./store/repository.ts");
  const { startTui } = await import("./tui/app.ts");
  const db = openDb(resolveDbPath());
  let failure: unknown = null;
  try {
    await startTui(new TaskRepository(db));
  } catch (error) {
    // startTui has already restored the terminal; exit explicitly so
    // OpenTUI's process handlers cannot keep Bun alive.
    failure = error;
  } finally {
    db.close();
  }
  if (failure !== null) {
    process.stderr.write(`eisen: ${failure instanceof Error ? failure.message : String(failure)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

process.exit(
  runCli(args, {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }),
);
