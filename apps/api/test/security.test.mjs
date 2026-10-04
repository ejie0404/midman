import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashInvitationToken, isInvitationUsable, newInvitationToken } from "../dist/invitations.js";
import { redact } from "../dist/audit.js";

describe("invitation secrets", () => {
  it("hashes tokens and never logs them", () => {
    const token = newInvitationToken();
    const hash = hashInvitationToken(token);
    assert.equal(hash.length, 64);
    assert.notEqual(hash, token);
    const logged = redact({ invitationToken: token, dealId: "abc" });
    assert.deepEqual(logged, { invitationToken: "[REDACTED]", dealId: "abc" });
  });
  it("honours expiry and revocation", () => {
    const base = { tokenHash: "x", dealId: "d", createdAt: "2026-01-01T00:00:00Z" };
    assert.equal(isInvitationUsable({ ...base, expiresAt: "2026-01-02T00:00:00Z", revoked: false }, "2026-01-01T12:00:00Z"), true);
    assert.equal(isInvitationUsable({ ...base, expiresAt: "2026-01-02T00:00:00Z", revoked: true }, "2026-01-01T12:00:00Z"), false);
  });
});
