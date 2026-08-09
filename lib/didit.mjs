import crypto from "node:crypto";

export const DIDIT_WORKFLOW_ID = "ca32cb1e-8787-4724-94c2-ba37e0202c75";

export const DIDIT_STATUSES = new Set([
  "Not Started",
  "In Progress",
  "Awaiting User",
  "In Review",
  "Approved",
  "Declined",
  "Resubmitted",
  "Abandoned",
  "Expired",
  "Kyc Expired",
]);

export function shortenFloats(value) {
  if (Array.isArray(value)) return value.map(shortenFloats);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, shortenFloats(entry)]),
    );
  }
  if (typeof value === "number" && !Number.isInteger(value) && value % 1 === 0) {
    return Math.trunc(value);
  }
  return value;
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortKeys(value[key]);
        return result;
      }, {});
  }
  return value;
}

export function canonicalizeDiditPayload(payload) {
  return JSON.stringify(sortKeys(shortenFloats(payload)));
}

export function verifyDiditSignature({ payload, signature, timestamp, secret, now = Date.now() }) {
  const numericTimestamp = Number(timestamp);
  if (!numericTimestamp || Math.abs(now / 1000 - numericTimestamp) > 300) {
    return { ok: false, reason: "stale" };
  }
  if (!secret) return { ok: false, reason: "unconfigured" };

  const supplied = String(signature || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[a-f0-9]{64}$/.test(supplied)) return { ok: false, reason: "signature" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(canonicalizeDiditPayload(payload), "utf8")
    .digest("hex");
  const suppliedBuffer = Buffer.from(supplied, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return {
    ok:
      suppliedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(suppliedBuffer, expectedBuffer),
    reason: "signature",
  };
}

export function summarizeDiditDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  const pluralModules = [
    "id_verifications",
    "nfc_verifications",
    "liveness_checks",
    "face_matches",
    "phone_verifications",
    "email_verifications",
    "poa_verifications",
    "aml_screenings",
    "ip_analyses",
    "database_validations",
    "reviews",
    "registry_checks",
    "document_verifications",
    "key_people_checks",
  ];
  const summary = {};
  for (const key of pluralModules) {
    if (!Array.isArray(decision[key])) continue;
    summary[key] = decision[key].map((entry) => ({
      node_id: entry?.node_id ?? null,
      status: entry?.status ?? null,
      score: typeof entry?.score === "number" ? entry.score : null,
      warning_count: Array.isArray(entry?.warnings) ? entry.warnings.length : 0,
    }));
  }
  return summary;
}
