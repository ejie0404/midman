import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("web shell", () => {
  it("states minimums without implying clicks move funds", () => {
    const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    assert.match(page, /5\.00 USDC/);
    assert.match(page, /inclusion is the only truth/);
  });
});
