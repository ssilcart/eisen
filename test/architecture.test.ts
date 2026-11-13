import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// S2: src/domain is pure logic; it must not reach I/O or the UI.
describe("layout", () => {
  test("src/domain imports nothing from bun:sqlite or @opentui", async () => {
    const offenders: string[] = [];
    for await (const file of new Glob("src/domain/**/*.ts").scan(".")) {
      const source = await Bun.file(file).text();
      if (/from\s+["'](bun:sqlite|@opentui\/[^"']*)["']/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
