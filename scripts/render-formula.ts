#!/usr/bin/env bun
// Renders the Homebrew formula (packaging/homebrew/eisen.rb.tmpl) for one
// release from its version and the SHA256SUMS the release workflow produced.
//
//   bun scripts/render-formula.ts --version 0.1.0 --sums dist/SHA256SUMS [--template <path>] > eisen.rb

import { join } from "node:path";

export const PLATFORMS = ["darwin-arm64", "linux-x64"] as const;
export type Platform = (typeof PLATFORMS)[number];

const DEFAULT_TEMPLATE = join(import.meta.dir, "../packaging/homebrew/eisen.rb.tmpl");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SUM_LINE = /^([0-9a-fA-F]{64}) [ *](.+)$/;

/** The release asset name the workflow uploads for a platform. */
export function assetName(version: string, platform: Platform): string {
  return `eisen-${version}-${platform}.tar.gz`;
}

/** Parses `sha256sum` output (`<hash>  <file>` or `<hash> *<file>`) into file → hash. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  text.split("\n").forEach((raw, index) => {
    const line = raw.trimEnd();
    if (line === "") return;
    const match = SUM_LINE.exec(line);
    if (!match) throw new Error(`SHA256SUMS line ${index + 1} is not "<sha256>  <file>": ${line}`);
    sums.set(match[2]!, match[1]!.toLowerCase());
  });
  return sums;
}

/** Fills every `{{PLACEHOLDER}}`; throws on a missing hash or an unknown placeholder. */
export function renderFormula(template: string, version: string, sums: Map<string, string>): string {
  if (!SEMVER.test(version)) throw new Error(`version must be X.Y.Z[-pre], got "${version}"`);
  const values: Record<string, string> = { VERSION: version };
  for (const platform of PLATFORMS) {
    const asset = assetName(version, platform);
    const hash = sums.get(asset);
    if (hash === undefined) throw new Error(`SHA256SUMS has no entry for ${asset}`);
    values[`SHA256_${platform.toUpperCase().replace("-", "_")}`] = hash;
  }
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`unknown placeholder ${placeholder} in the template`);
    return value;
  });
}

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE =
  "usage: bun scripts/render-formula.ts --version <X.Y.Z> --sums <SHA256SUMS> [--template <file>]\n";

/** CLI entry point; returns the exit code (0 ok, 1 error, 2 usage). */
export async function runRenderFormula(argv: string[], io: Io): Promise<number> {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !["--version", "--sums", "--template"].includes(flag) || value === undefined) {
      io.stderr(USAGE);
      return 2;
    }
    options[flag.slice(2)] = value;
  }
  const { version, sums } = options;
  if (version === undefined || sums === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const template = await Bun.file(options.template ?? DEFAULT_TEMPLATE).text();
    const parsed = parseSha256Sums(await Bun.file(sums).text());
    io.stdout(renderFormula(template, version, parsed));
    return 0;
  } catch (error) {
    io.stderr(`render-formula: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(
    await runRenderFormula(Bun.argv.slice(2), {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    }),
  );
}
