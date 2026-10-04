import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyMessage } from "viem";
import {
  sha256hex,
  EMPTY_SHA256_HEX,
  prescreenSecrets,
  validateUploadFile,
  encodeMultipartForm,
  createInitialDeliveryForm,
  validateDeliveryForm,
  deliveryFormReducer,
  fetchCategories,
  submitDeliveryForm,
  uploadEvidence,
  fetchManifest,
  fetchMessages,
  postMessage,
  postRestoreCheck,
  isEndpointMissing,
  isAccessDenied,
  shortHash,
  MAX_MESSAGE_LEN,
  DeliveryFormError,
} from "../lib/evidence.ts";
import { signRequest } from "../lib/requestAuth.ts";
import { ApiError } from "../lib/api.ts";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

// Signatures below are real secp256k1 EIP-191 personal_sign signatures over the
// exact `message` strings, made offline with the fixed key
// 0x0707…07 (address 0x4a62316623ad457F02cDC5D997deD67a383EC569).
// The tests assert signRequest reproduces the message byte-for-byte and that
// viem verifies the signature over it.
const VECTOR_POST = {
  method: "POST",
  path: "/deals/0x1234/evidence",
  body: "abc",
  nowSec: 1700000000,
  address: "0x4a62316623ad457F02cDC5D997deD67a383EC569",
  message:
    "POST\n/deals/0x1234/evidence\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n1700000300",
  signature:
    "0xe1a11686d4aec96d78ec7525fe38be75e40c5ab1cc25d7a8497ff12bd75ce1631a09036b405199a5130da946208c235aa3a30b30ab7ff1a890b022d306b66a231b",
};

const VECTOR_GET = {
  method: "GET",
  path: "/evidence/0xabc/receipt?dealId=0x1234",
  body: undefined,
  nowSec: 1700000000,
  address: "0x4a62316623ad457F02cDC5D997deD67a383EC569",
  message:
    "GET\n/evidence/0xabc/receipt?dealId=0x1234\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1700000300",
  signature:
    "0xbf2fd8fbd94a6b953d7ee0d55d0fe131c574014c8816caef53ce8c9bf198ad9d237bcdf7c3b0494d2d71e51767dc2dc952a01a0a713894276946495d9b73c5291c",
};

function stubSigner(address, signature, seen) {
  return {
    address,
    signMessage: async (message) => {
      seen.push(message);
      return signature;
    },
  };
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CATEGORY = {
  id: "GAME_ITEM",
  minInspection: 43200,
  fields: [
    { name: "title", label: "Title", type: "text", required: true, maxLen: 10 },
    { name: "count", label: "Count", type: "number", required: true },
    { name: "notes", label: "Notes", type: "textarea", required: false, maxLen: 50 },
  ],
  completionCriteria: "Buyer confirms receipt in game.",
};

describe("sha256hex", () => {
  it("matches fixture vectors for empty and abc", async () => {
    assert.equal(await sha256hex(""), EMPTY_SHA256_HEX);
    assert.equal(await sha256hex("abc"), ABC_SHA256);
  });

  it("hashes raw bytes identically to their UTF-8 string", async () => {
    assert.equal(await sha256hex(new Uint8Array([97, 98, 99])), ABC_SHA256);
  });
});

describe("prescreenSecrets (warning only)", () => {
  it("hits on credential-looking content", () => {
    assert.equal(prescreenSecrets("-----BEGIN PRIVATE KEY-----\nabc").hit, true);
    assert.deepEqual(prescreenSecrets("key is sk-live-abc123XYZ7890 ok").matched, ["api-secret"]);
    const hexKey = `my private key 0x${"ab".repeat(32)} do not share`;
    const hit = prescreenSecrets(hexKey);
    assert.equal(hit.hit, true);
    assert.ok(hit.matched.includes("hex-private-key"));
    assert.ok(prescreenSecrets("my seed phrase apple banana cherry date egg fruit grape honey ice juice kiwi lemon").hit);
  });

  it("misses ordinary delivery text and bare hashes", () => {
    assert.equal(prescreenSecrets("Delivery completed on time, tracking 1Z999AA10123456784").hit, false);
    assert.equal(prescreenSecrets("contact support@example.com for help").hit, false);
    assert.equal(prescreenSecrets("tx 0x1234 confirmed").hit, false);
    // A bare 64-hex file hash without key context must not warn.
    assert.equal(prescreenSecrets(`file hash ${"ab".repeat(32)} uploaded`).hit, false);
  });

  it("never echoes the secret back", () => {
    const secret = `sk-live-${"Z".repeat(24)}`;
    const result = prescreenSecrets(`leaked ${secret}`);
    assert.ok(!JSON.stringify(result).includes(secret));
  });
});

describe("signRequest", () => {
  it("builds the exact header shape with default 5-minute expiry", async () => {
    const seen = [];
    const signed = await signRequest(stubSigner("0xabc", "0xsig", seen), "post", "/deals/0x1/evidence", "abc", {
      nowSec: 1700000000,
    });
    assert.equal(signed.message, VECTOR_POST.message.replace("/deals/0x1234/evidence", "/deals/0x1/evidence"));
    assert.equal(signed.expiry, 1700000300);
    assert.equal(signed.bodyHash, ABC_SHA256);
    assert.deepEqual(signed.headers, {
      "x-wallet-address": "0xabc",
      "x-wallet-expiry": "1700000300",
      "x-wallet-signature": "0xsig",
    });
    assert.deepEqual(seen, [signed.message]);
  });

  it("signs the empty hash when no body is given", async () => {
    const seen = [];
    const signed = await signRequest(stubSigner("0xabc", "0xsig", seen), "GET", "/categories", undefined, {
      nowSec: 1700000000,
    });
    assert.equal(signed.bodyHash, EMPTY_SHA256_HEX);
    assert.ok(signed.message.includes(`\n${EMPTY_SHA256_HEX}\n`));
  });

  it("rejects windows beyond 15 minutes and bad inputs", async () => {
    const signer = stubSigner("0xabc", "0xsig", []);
    await assert.rejects(() => signRequest(signer, "GET", "/x", undefined, { expiresInSec: 901 }), RangeError);
    await assert.rejects(() => signRequest(signer, "GET", "no-slash", undefined), Error);
    await assert.rejects(() => signRequest({ address: "", signMessage: async () => "0x" }, "GET", "/x"), Error);
  });

  it("reproduces the fixed-vector POST message, verified by viem", async () => {
    const seen = [];
    const signed = await signRequest(
      stubSigner(VECTOR_POST.address, VECTOR_POST.signature, seen),
      VECTOR_POST.method,
      VECTOR_POST.path,
      VECTOR_POST.body,
      { nowSec: VECTOR_POST.nowSec },
    );
    assert.equal(signed.message, VECTOR_POST.message);
    assert.equal(
      await verifyMessage({ address: VECTOR_POST.address, message: signed.message, signature: VECTOR_POST.signature }),
      true,
    );
  });

  it("reproduces the fixed-vector GET message (query string included), verified by viem", async () => {
    const seen = [];
    const signed = await signRequest(
      stubSigner(VECTOR_GET.address, VECTOR_GET.signature, seen),
      VECTOR_GET.method,
      VECTOR_GET.path,
      VECTOR_GET.body,
      { nowSec: VECTOR_GET.nowSec },
    );
    assert.equal(signed.message, VECTOR_GET.message);
    assert.equal(
      await verifyMessage({ address: VECTOR_GET.address, message: signed.message, signature: VECTOR_GET.signature }),
      true,
    );
  });
});

describe("delivery form reducer", () => {
  it("sets values and clears the field error", () => {
    let state = createInitialDeliveryForm();
    state = deliveryFormReducer(state, { type: "validate", category: CATEGORY });
    assert.ok(state.errors["title"]);
    state = deliveryFormReducer(state, { type: "set", name: "title", value: "Sword" });
    assert.equal(state.values["title"], "Sword");
    assert.equal(state.errors["title"], undefined);
  });

  it("flags missing required, maxLen, and non-numeric input", () => {
    const errors = validateDeliveryForm(CATEGORY, { title: "way too long title", count: "many", notes: "" });
    assert.ok(errors["title"]?.includes("at most 10"));
    assert.ok(errors["count"]?.includes("must be a number"));
    assert.equal(errors["notes"], undefined);
    assert.deepEqual(validateDeliveryForm(CATEGORY, { title: "Sword", count: "3", notes: "" }), {});
  });

  it("records server-side errors without losing values", () => {
    let state = deliveryFormReducer(createInitialDeliveryForm(), {
      type: "set",
      name: "title",
      value: "Sword",
    });
    state = deliveryFormReducer(state, { type: "serverErrors", errors: ["category closed"] });
    assert.deepEqual(state.serverErrors, ["category closed"]);
    assert.equal(state.values["title"], "Sword");
    state = deliveryFormReducer(state, { type: "clear" });
    assert.deepEqual(state, { values: {}, errors: {}, serverErrors: [] });
  });
});

describe("multipart encoder", () => {
  it("frames fields and file bytes deterministically with a fixed boundary", async () => {
    const fileBytes = new Uint8Array([1, 2, 3]);
    const encoded = encodeMultipartForm({
      fields: { kind: "screenshot", description: "hi" },
      fileField: "file",
      file: { name: "shot.png", contentType: "image/png", bytes: fileBytes },
      boundary: "test-boundary",
    });
    assert.equal(encoded.contentType, "multipart/form-data; boundary=test-boundary");
    const text = new TextDecoder().decode(encoded.body);
    assert.ok(text.includes('name="kind"'));
    assert.ok(text.includes("screenshot"));
    assert.ok(text.includes('filename="shot.png"'));
    assert.ok(text.endsWith("--test-boundary--\r\n"));
    // Raw file bytes survive verbatim inside the body.
    assert.ok(encoded.body.includes(1) && encoded.body.includes(2));
    const hash = await sha256hex(encoded.body);
    assert.equal(hash, await sha256hex(encoded.body));
    assert.equal(hash.length, 64);
  });
});

describe("evidence API wrappers (mocked fetch)", () => {
  const auth = { address: "0xabc", signMessage: async () => "0xsig" };

  it("uploads multipart with an empty-body signature (server rule)", async () => {
    let captured;
    let signedMessage = null;
    const recordingAuth = {
      address: "0xabc",
      signMessage: async (message) => {
        signedMessage = message;
        return "0xsig";
      },
    };
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return jsonResponse(200, { seq: 2, fileHash: "0xhash", commitment: "0xcommit", receipt: { ok: true }, scan: "clean" });
    };
    const bytes = new TextEncoder().encode("file-contents");
    const result = await uploadEvidence(
      "0xdeal",
      { fileName: "proof.txt", contentType: "text/plain", fileBytes: bytes, kind: "receipt", description: "drop" },
      recordingAuth,
      fetchImpl,
    );
    assert.equal(result.seq, 2);
    assert.equal(result.commitment, "0xcommit");
    assert.ok(captured.url.endsWith("/deals/0xdeal/evidence"));
    assert.equal(captured.init.method, "POST");
    assert.ok(String(captured.init.headers["content-type"]).startsWith("multipart/form-data; boundary="));
    assert.ok(captured.init.headers["x-wallet-signature"], "signed");
    // Server rule: multipart boundaries are not canonical, so the signature
    // covers the EMPTY body hash while the real bytes are transmitted.
    const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    assert.ok(signedMessage.includes(`/deals/0xdeal/evidence\n${EMPTY_SHA256}\n`), "empty-hash signed");
    assert.ok(!signedMessage.includes(await sha256hex(captured.init.body)), "raw bytes not signed");
  });

  it("rejects oversize and executable files before any fetch", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return jsonResponse(200, {});
    };
    await assert.rejects(
      () =>
        uploadEvidence(
          "0xdeal",
          { fileName: "big.bin", contentType: "application/octet-stream", fileBytes: new Uint8Array(26 * 1024 * 1024), kind: "k", description: "d" },
          auth,
          fetchImpl,
        ),
      /25 MB/,
    );
    await assert.rejects(
      () =>
        uploadEvidence(
          "0xdeal",
          { fileName: "run.exe", contentType: "application/octet-stream", fileBytes: new Uint8Array([1]), kind: "k", description: "d" },
          auth,
          fetchImpl,
        ),
      /Executable/,
    );
    assert.equal(called, false);
  });

  it("surfaces delivery-form 400s as DeliveryFormError", async () => {
    const fetchImpl = async () => jsonResponse(400, { errors: ["title is required"] });
    await assert.rejects(
      submitDeliveryForm("0xdeal", "GAME_ITEM", {}, auth, fetchImpl),
      (error) => {
        assert.ok(error instanceof DeliveryFormError);
        assert.deepEqual(error.errors, ["title is required"]);
        return true;
      },
    );
    const okImpl = async () => jsonResponse(200, { ok: true, deliveryManifestHash: "0xmanifest" });
    const ok = await submitDeliveryForm("0xdeal", "GAME_ITEM", { title: "Sword" }, auth, okImpl);
    assert.equal(ok.deliveryManifestHash, "0xmanifest");
  });

  it("lets 404s propagate for UI fallback and parses bare message arrays", async () => {
    const missing = async () => jsonResponse(404, { error: "not found" });
    const categoriesError = await fetchCategories(auth, missing).then(
      () => null,
      (error) => error,
    );
    assert.ok(categoriesError instanceof ApiError && categoriesError.status === 404);
    assert.equal(isEndpointMissing(categoriesError), true);
    assert.equal(isAccessDenied(new ApiError(403, "nope")), true);

    const messages = await fetchMessages(
      "0xdeal",
      auth,
      async () => jsonResponse(200, [{ seq: 0, author: "0xa", text: "hi", at: "2026-01-01T00:00:00Z" }]),
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, "hi");

    await assert.rejects(() => postMessage("0xdeal", "   ", auth), /empty/);
    await assert.rejects(() => postMessage("0xdeal", "x".repeat(MAX_MESSAGE_LEN + 1), auth), /2000/);

    const restore = await postRestoreCheck("0xdeal", auth, async () =>
      jsonResponse(200, { ok: true, detail: "2 files verified" }),
    );
    assert.equal(restore.ok, true);

    const manifest = await fetchManifest("0xdeal", auth, async () =>
      jsonResponse(200, { manifest: [], head: "0xhead" }),
    );
    assert.equal(manifest.head, "0xhead");
  });
});

describe("validateUploadFile + shortHash", () => {
  it("accepts ordinary files and rejects empties", () => {
    assert.deepEqual(validateUploadFile({ name: "a.png", sizeBytes: 10 }), { ok: true });
    assert.equal(validateUploadFile({ name: "a.png", sizeBytes: 0 }).ok, false);
  });

  it("shortens hashes for badges", () => {
    assert.equal(shortHash(`0x${"ab".repeat(32)}`), `0x${"ab".repeat(4)}…${"ab".repeat(4)}`);
    assert.equal(shortHash("short"), "short");
  });
});
