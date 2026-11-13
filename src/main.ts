#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };

const args = Bun.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

console.log("eisen: not implemented yet");
