import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  canonicalizeDiditPayload,
  summarizeDiditDecision,
  verifyDiditSignature,
} from "../lib/didit.mjs";

test("Didit canonicalization sorts nested keys and preserves array order", () => {
  assert.equal(
    canonicalizeDiditPayload({ z: 2, a: { y: 3, b: 1 }, list: [{ d: 4, c: 3 }] }),
    '{"a":{"b":1,"y":3},"list":[{"c":3,"d":4}],"z":2}',
  );
});

test("Didit signature verifier accepts a fresh valid HMAC and rejects stale requests", () => {
  const payload = { status: "Approved", event_id: "evt-1", vendor_data: "0xabc" };
  const secret = "test-secret";
  const timestamp = 1_780_000_000;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(canonicalizeDiditPayload(payload))
    .digest("hex");
  assert.equal(
    verifyDiditSignature({ payload, signature, timestamp, secret, now: timestamp * 1000 }).ok,
    true,
  );
  assert.equal(
    verifyDiditSignature({ payload, signature, timestamp, secret, now: (timestamp + 301) * 1000 })
      .reason,
    "stale",
  );
});

test("decision summary discards document PII and keeps operational status", () => {
  const summary = summarizeDiditDecision({
    id_verifications: [
      {
        node_id: "ocr",
        status: "Approved",
        document_number: "SECRET",
        first_name: "Name",
        warnings: ["blur"],
      },
    ],
  });
  assert.deepEqual(summary.id_verifications[0], {
    node_id: "ocr",
    status: "Approved",
    score: null,
    warning_count: 1,
  });
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
});
