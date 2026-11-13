#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { runCli } from "./cli/cli.ts";

const args = Bun.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

process.exit(
  runCli(args, {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }),
);
