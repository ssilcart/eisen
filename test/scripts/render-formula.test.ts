import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetName,
  parseSha256Sums,
  renderFormula,
  runRenderFormula,
} from "../../scripts/render-formula.ts";

const TEMPLATE_PATH = join(import.meta.dir, "../../packaging/homebrew/eisen.rb.tmpl");
const DARWIN = "a".repeat(64);
const LINUX = "b".repeat(64);
const SUMS = `${DARWIN}  eisen-0.1.0-darwin-arm64.tar.gz\n${LINUX} *eisen-0.1.0-linux-x64.tar.gz\n`;

describe("parseSha256Sums", () => {
  test("reads sha256sum output in text and binary mode", () => {
    const sums = parseSha256Sums(SUMS);
    expect(sums.get("eisen-0.1.0-darwin-arm64.tar.gz")).toBe(DARWIN);
    expect(sums.get("eisen-0.1.0-linux-x64.tar.gz")).toBe(LINUX);
  });

  test("lowercases hashes and ignores blank lines", () => {
    const sums = parseSha256Sums(`\n${"C".repeat(64)}  x.tar.gz\n\n`);
    expect(sums.get("x.tar.gz")).toBe("c".repeat(64));
    expect(sums.size).toBe(1);
  });

  test("rejects a malformed line with its number", () => {
    expect(() => parseSha256Sums(`${DARWIN}  ok.tar.gz\nnot-a-hash  x.tar.gz\n`)).toThrow(
      "SHA256SUMS line 2",
    );
  });
});

describe("assetName", () => {
  test("follows eisen-<version>-<platform>.tar.gz", () => {
    expect(assetName("0.1.0", "darwin-arm64")).toBe("eisen-0.1.0-darwin-arm64.tar.gz");
  });
});

describe("renderFormula", () => {
  test("fills version, URLs and both sha256s in the real template", async () => {
    const template = await Bun.file(TEMPLATE_PATH).text();
    const formula = renderFormula(template, "0.1.0", parseSha256Sums(SUMS));
    expect(formula).not.toContain("{{");
    expect(formula).toContain('version "0.1.0"');
    expect(formula).toContain(
      'url "https://github.com/ssilcart/eisen/releases/download/v0.1.0/eisen-0.1.0-darwin-arm64.tar.gz"',
    );
    expect(formula).toContain(
      'url "https://github.com/ssilcart/eisen/releases/download/v0.1.0/eisen-0.1.0-linux-x64.tar.gz"',
    );
    expect(formula).toContain(`sha256 "${DARWIN}"`);
    expect(formula).toContain(`sha256 "${LINUX}"`);
    // Each sha256 sits right after the URL of its own platform.
    expect(formula.indexOf(DARWIN)).toBeGreaterThan(formula.indexOf("darwin-arm64.tar.gz"));
    expect(formula.indexOf(DARWIN)).toBeLessThan(formula.indexOf("linux-x64.tar.gz"));
    expect(formula).toContain('bin.install "eisen"');
    expect(formula).toContain("--version");
  });

  test("fails when an asset is missing from SHA256SUMS", () => {
    const only = parseSha256Sums(`${DARWIN}  eisen-0.1.0-darwin-arm64.tar.gz\n`);
    expect(() => renderFormula("{{SHA256_LINUX_X64}}", "0.1.0", only)).toThrow(
      "eisen-0.1.0-linux-x64.tar.gz",
    );
  });

  test("fails on an unknown placeholder instead of leaving it in the formula", () => {
    expect(() => renderFormula("{{NOPE}}", "0.1.0", parseSha256Sums(SUMS))).toThrow("{{NOPE}}");
  });

  test("rejects a version that is not semver (e.g. the tag with its v)", () => {
    expect(() => renderFormula("", "v0.1.0", parseSha256Sums(SUMS))).toThrow("version");
  });
});

describe("runRenderFormula (CLI)", () => {
  test("prints the formula for --version and --sums", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eisen-formula-"));
    const sumsPath = join(dir, "SHA256SUMS");
    await Bun.write(sumsPath, SUMS);
    let out = "";
    let err = "";
    const code = await runRenderFormula(["--version", "0.1.0", "--sums", sumsPath], {
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
    });
    rmSync(dir, { recursive: true, force: true });
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("class Eisen < Formula");
    expect(out).toContain(`sha256 "${LINUX}"`);
  });

  test("exits 2 with usage when an argument is missing", async () => {
    let err = "";
    const code = await runRenderFormula(["--version", "0.1.0"], {
      stdout: () => {},
      stderr: (s) => (err += s),
    });
    expect(code).toBe(2);
    expect(err).toContain("usage");
  });
});
