import crypto from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import {
  Contract,
  JsonRpcProvider,
  formatUnits,
  getAddress,
  isAddress,
  verifyMessage,
} from "ethers";
import {
  DIDIT_STATUSES,
  DIDIT_WORKFLOW_ID,
  summarizeDiditDecision,
  verifyDiditSignature,
} from "./lib/didit.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, ".data"));
const PUBLIC_URL = String(process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const ADMIN_WALLET = normalizeWallet(process.env.ADMIN_WALLET || "");
const DIDIT_API_KEY = process.env.DIDIT_API_KEY || "";
const DIDIT_WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET || "";
const DIDIT_WHITE_LABEL = /^(1|true|yes)$/i.test(process.env.DIDIT_WHITE_LABEL || "false");
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const ASH_CONTRACT = normalizeWallet(
  process.env.ASH_CONTRACT || "0xd4FbB5E4Dd24C3F9A0F58Efa656A489D24E93BCd",
);
const ASH_SWAP_CONTRACT = normalizeWallet(
  process.env.ASH_SWAP_CONTRACT || "0xE5104018379973BA5a65b82bC7E876b766357de6",
);
const USDC_CONTRACT = normalizeWallet(
  process.env.USDC_CONTRACT || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
);
const NFT_COLLECTION_ADDRESS = normalizeWallet(process.env.NFT_COLLECTION_ADDRESS || "");
const SESSION_COOKIE = "phoenix_session";
const secureCookies = PUBLIC_URL.startsWith("https://");

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "phoenix.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
initDatabase();
seedQuizzes();

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(self \"https://verify.didit.me\"), microphone=(self \"https://verify.didit.me\"), geolocation=()");
  if (secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "phoenix-site", database: "ready" });
});

app.post(
  "/api/webhooks/didit",
  express.text({ type: "*/*", limit: "512kb" }),
  (req, res) => {
    let payload;
    try {
      payload = JSON.parse(req.body || "{}");
    } catch {
      return res.status(400).send("invalid json");
    }

    const verified = verifyDiditSignature({
      payload,
      signature: req.get("x-signature-v2"),
      timestamp: req.get("x-timestamp"),
      secret: DIDIT_WEBHOOK_SECRET,
    });
    if (!verified.ok) {
      const status = verified.reason === "unconfigured" ? 503 : 401;
      return res.status(status).send(verified.reason);
    }

    const eventId = cleanText(payload.event_id, 100);
    const wallet = normalizeWallet(payload.vendor_data || "");
    const status = String(payload.status || "");
    if (!eventId || !wallet || !DIDIT_STATUSES.has(status)) {
      return res.status(400).send("invalid event");
    }

    const alreadyProcessed = db
      .prepare("SELECT 1 FROM didit_events WHERE event_id = ?")
      .get(eventId);
    if (alreadyProcessed) return res.status(200).send("ok");

    const now = new Date().toISOString();
    const payloadHash = crypto.createHash("sha256").update(req.body).digest("hex");
    const decisionSummary = summarizeDiditDecision(payload.decision);
    try {
      db.exec("BEGIN IMMEDIATE");
      upsertUser(wallet, { source: "didit_webhook", lastSeenAt: now });
      db.prepare(
        `UPDATE users
         SET kyc_status = ?, kyc_session_id = COALESCE(?, kyc_session_id),
             kyc_updated_at = ?, kyc_summary_json = ?,
             status = CASE WHEN ? = 'Kyc Expired' THEN 'review' ELSE status END
         WHERE wallet = ?`,
      ).run(
        status,
        cleanText(payload.session_id, 100) || null,
        now,
        decisionSummary ? JSON.stringify(decisionSummary) : null,
        status,
        wallet,
      );
      db.prepare(
        `INSERT INTO didit_events
         (event_id, session_id, wallet, webhook_type, status, payload_hash, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        cleanText(payload.session_id, 100),
        wallet,
        cleanText(payload.webhook_type, 80),
        status,
        payloadHash,
        now,
      );
      addAudit("Didit", "KYC status updated", shortWallet(wallet), "OK", status);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      console.error("Didit webhook transaction failed", error);
      return res.status(500).send("temporary failure");
    }
    return res.status(200).send("ok");
  },
);

app.use(express.json({ limit: "256kb" }));

const rateBuckets = new Map();
function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${clientKey(req)}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > limit) return res.status(429).json({ error: "rate_limited" });
    next();
  };
}

app.get("/api/config", (_req, res) => {
  res.json({
    chain: { id: 8453, name: "Base", explorer: "https://basescan.org" },
    contracts: {
      ash: ASH_CONTRACT,
      swap: ASH_SWAP_CONTRACT,
      usdc: USDC_CONTRACT,
      nftCollection: NFT_COLLECTION_ADDRESS || null,
    },
    kyc: { provider: "Didit", brand: DIDIT_WHITE_LABEL ? "Phoenix" : "Didit", workflow: "Free KYC", whiteLabel: DIDIT_WHITE_LABEL, enabled: Boolean(DIDIT_API_KEY) },
  });
});

app.post("/api/auth/challenge", rateLimit("challenge", 12, 60_000), (req, res) => {
  const wallet = normalizeWallet(req.body?.wallet || "");
  if (!wallet) return res.status(400).json({ error: "invalid_wallet" });
  const nonce = crypto.randomBytes(18).toString("hex");
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const message = [
    "Phoenix — accesso tramite wallet",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Emesso: ${issuedAt}`,
    "",
    "Questa firma non invia transazioni e non comporta costi.",
  ].join("\n");
  db.prepare(
    `INSERT INTO auth_challenges (wallet, nonce, message, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET nonce=excluded.nonce, message=excluded.message,
       expires_at=excluded.expires_at`,
  ).run(wallet, nonce, message, expiresAt);
  res.json({ wallet, message, expiresAt });
});

app.post("/api/auth/verify", rateLimit("verify", 12, 60_000), (req, res) => {
  const wallet = normalizeWallet(req.body?.wallet || "");
  const signature = cleanText(req.body?.signature, 1024);
  if (!wallet || !signature) return res.status(400).json({ error: "invalid_request" });
  const challenge = db
    .prepare("SELECT message, expires_at FROM auth_challenges WHERE wallet = ?")
    .get(wallet);
  if (!challenge || Date.parse(challenge.expires_at) < Date.now()) {
    return res.status(401).json({ error: "challenge_expired" });
  }
  let recovered;
  try {
    recovered = normalizeWallet(verifyMessage(challenge.message, signature));
  } catch {
    return res.status(401).json({ error: "invalid_signature" });
  }
  if (recovered !== wallet) return res.status(401).json({ error: "invalid_signature" });

  db.prepare("DELETE FROM auth_challenges WHERE wallet = ?").run(wallet);
  const isAdmin = Boolean(ADMIN_WALLET && wallet === ADMIN_WALLET);
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + (isAdmin ? 12 : 24 * 7) * 60 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO sessions (token_hash, wallet, is_admin, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash, wallet, isAdmin ? 1 : 0, new Date().toISOString(), expiresAt);
  upsertUser(wallet, { source: "wallet_signature", lastSeenAt: new Date().toISOString() });
  if (isAdmin) addAudit(shortWallet(wallet), "Admin login", "Session", "OK", "Wallet signature");
  setSessionCookie(res, token, expiresAt);
  res.json({ authenticated: true, wallet, admin: isAdmin, expiresAt });
});

app.get("/api/auth/me", (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, wallet: session.wallet, admin: Boolean(session.is_admin) });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? "; Secure" : ""}`,
  );
  res.json({ ok: true });
});

app.post("/api/wallets/register", rateLimit("wallet", 30, 60_000), (req, res) => {
  const wallet = normalizeWallet(req.body?.wallet || "");
  if (!wallet) return res.status(400).json({ error: "invalid_wallet" });
  const now = new Date().toISOString();
  const chainId = normalizeChainId(req.body?.chainId);
  upsertUser(wallet, {
    chainId,
    source: cleanText(req.body?.source, 40) || "website",
    lastSeenAt: now,
  });
  if (req.body?.analyticsConsent === true) {
    recordEvent(req, {
      event: "wallet_connect",
      visitorId: cleanText(req.body?.visitorId, 100),
      wallet,
      path: cleanPath(req.body?.path || "/"),
      metadata: { chainId },
      analyticsConsent: true,
      consentVersion: cleanText(req.body?.consentVersion, 30),
    });
  }
  res.status(201).json({ registered: true, wallet, joined: true });
});

app.post("/api/events", rateLimit("events", 120, 60_000), (req, res) => {
  if (req.body?.analyticsConsent !== true) {
    return res.status(202).json({ accepted: false, reason: "analytics_consent_required" });
  }
  const event = cleanText(req.body?.event, 48);
  const visitorId = cleanText(req.body?.visitorId, 100);
  if (!event || !/^[a-z][a-z0-9_]{1,47}$/.test(event) || !visitorId) {
    return res.status(400).json({ error: "invalid_event" });
  }
  recordEvent(req, {
    event,
    visitorId,
    wallet: normalizeWallet(req.body?.wallet || ""),
    path: cleanPath(req.body?.path || "/"),
    referrer: cleanText(req.body?.referrer, 500),
    source: cleanText(req.body?.source, 80),
    metadata: safeMetadata(req.body?.metadata),
    analyticsConsent: true,
    consentVersion: cleanText(req.body?.consentVersion, 30),
  });
  res.status(202).json({ accepted: true });
});

app.post("/api/analytics/consent/withdraw", rateLimit("analytics-withdraw", 12, 60_000), (req, res) => {
  const visitorId = cleanText(req.body?.visitorId, 100);
  if (!visitorId) return res.status(400).json({ error: "invalid_visitor" });
  const removed = db.prepare("DELETE FROM events WHERE visitor_id=?").run(visitorId);
  res.json({ removed: Number(removed.changes || 0) });
});

app.get("/api/kyc/status", requireSession, (req, res) => {
  const user = db
    .prepare("SELECT kyc_status, kyc_session_id, kyc_updated_at FROM users WHERE wallet = ?")
    .get(req.session.wallet);
  res.json({
    provider: "Didit",
    brand: DIDIT_WHITE_LABEL ? "Phoenix" : "Didit",
    whiteLabel: DIDIT_WHITE_LABEL,
    status: user?.kyc_status || "Not Started",
    sessionId: user?.kyc_session_id || null,
    updatedAt: user?.kyc_updated_at || null,
  });
});

app.get("/api/user/profile", requireSession, async (req, res) => {
  const now = new Date().toISOString();
  upsertUser(req.session.wallet, { source: "profile", lastSeenAt: now });
  const row = db.prepare(
    `SELECT wallet, joined_at, last_seen_at, chain_id, source, kyc_status,
            kyc_session_id, kyc_updated_at, status, nft_count, nft_collection,
            tests_json, quiz_completions, ash_issued, usdc_paid
     FROM users WHERE wallet=?`,
  ).get(req.session.wallet);
  const user = mapUser(row);
  const balances = await readWalletState(req.session.wallet);
  if (NFT_COLLECTION_ADDRESS && balances.nftCount != null && balances.nftCount !== user.nftCount) {
    db.prepare("UPDATE users SET nft_count=?, nft_collection=? WHERE wallet=?").run(
      balances.nftCount,
      NFT_COLLECTION_ADDRESS,
      req.session.wallet,
    );
    user.nftCount = balances.nftCount;
    user.nftCollection = NFT_COLLECTION_ADDRESS;
  }
  const activity = db.prepare(
    `SELECT event, type, usdc_delta usdcDelta, ash_delta ashDelta,
            tx_hash txHash, status, created_at createdAt
     FROM ledger WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT 100`,
  ).all(req.session.wallet);
  res.json({
    generatedAt: now,
    account: {
      wallet: user.wallet,
      joinedAt: user.joinedAt,
      lastSeenAt: user.lastSeenAt,
      chainId: user.chainId || 8453,
      source: user.source,
      status: user.status,
    },
    kyc: {
      provider: "Didit",
      brand: DIDIT_WHITE_LABEL ? "Phoenix" : "Didit",
      whiteLabel: DIDIT_WHITE_LABEL,
      status: user.kycStatus,
      sessionId: user.kycSessionId,
      updatedAt: user.kycUpdatedAt,
      enabled: Boolean(DIDIT_API_KEY),
    },
    learning: {
      tests: user.tests,
      quizCompletions: user.quizCompletions,
    },
    rewards: {
      ashIssued: user.ashIssued,
      usdcPaid: user.usdcPaid,
    },
    nft: {
      network: "Base",
      collection: NFT_COLLECTION_ADDRESS || null,
      count: NFT_COLLECTION_ADDRESS ? Number(balances.nftCount || 0) : user.nftCount,
      configured: Boolean(NFT_COLLECTION_ADDRESS),
    },
    balances,
    activity,
  });
});

app.post("/api/user/progress", requireSession, rateLimit("user-progress", 20, 60_000), (req, res) => {
  const tests = Array.isArray(req.body?.tests)
    ? req.body.tests.map((test) => cleanText(test, 180)).filter(Boolean).slice(0, 12)
    : [];
  const quizCompletions = Number(req.body?.quizCompletions || 0);
  if (tests.length > 12 || !Number.isInteger(quizCompletions) || quizCompletions < 0 || quizCompletions > 100_000) {
    return res.status(400).json({ error: "invalid_progress" });
  }
  db.prepare(
    `UPDATE users SET tests_json=?, quiz_completions=MAX(quiz_completions,?), last_seen_at=? WHERE wallet=?`,
  ).run(JSON.stringify(tests), quizCompletions, new Date().toISOString(), req.session.wallet);
  res.json({ synced: true, tests, quizCompletions });
});

app.post("/api/kyc/session", rateLimit("kyc", 5, 60_000), requireSession, async (req, res) => {
  if (!DIDIT_API_KEY) return res.status(503).json({ error: "kyc_unconfigured" });
  if (req.body?.consent !== true) return res.status(400).json({ error: "consent_required" });
  const current = db
    .prepare("SELECT kyc_status FROM users WHERE wallet = ?")
    .get(req.session.wallet);
  if (current?.kyc_status === "Approved") {
    return res.status(409).json({ error: "already_approved" });
  }

  const response = await fetch("https://verification.didit.me/v3/session/", {
    method: "POST",
    headers: { "x-api-key": DIDIT_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      workflow_id: DIDIT_WORKFLOW_ID,
      vendor_data: req.session.wallet,
      callback: `${PUBLIC_URL}/kyc.html?returned=1`,
      callback_method: "both",
      language: "it",
      metadata: { network: "Base", source: "phoenix-site", brand: "Phoenix", white_label: DIDIT_WHITE_LABEL },
    }),
  }).catch(() => null);
  if (!response?.ok) {
    const upstreamStatus = response?.status || 0;
    console.error("Didit session creation failed", upstreamStatus);
    return res.status(502).json({ error: "session_create_failed" });
  }
  const session = await response.json();
  if (!session?.url || !session?.session_id) {
    return res.status(502).json({ error: "invalid_didit_response" });
  }
  db.prepare(
    `UPDATE users SET kyc_status=?, kyc_session_id=?, kyc_updated_at=? WHERE wallet=?`,
  ).run(session.status || "Not Started", session.session_id, new Date().toISOString(), req.session.wallet);
  addAudit(shortWallet(req.session.wallet), "KYC session created", session.session_id, "OK", "Didit");
  res.json({ url: session.url, sessionId: session.session_id });
});

app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  const days = req.query.days === "all" ? "all" : [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = days === "all" ? "1970-01-01T00:00:00.000Z" : new Date(Date.now() - days * 86_400_000).toISOString();
  const users = db
    .prepare(
      `SELECT wallet, joined_at, last_seen_at, chain_id, source, kyc_status,
              kyc_session_id, kyc_updated_at, status, risk, nft_count,
              nft_collection, tests_json, quiz_completions, ash_issued, usdc_paid
       FROM users ORDER BY last_seen_at DESC`,
    )
    .all()
    .map(mapUser);
  const quizzes = db
    .prepare("SELECT * FROM quizzes ORDER BY updated_at DESC")
    .all()
    .map(mapQuiz);
  const ledger = db.prepare("SELECT * FROM ledger ORDER BY created_at DESC LIMIT 500").all();
  const audit = db.prepare("SELECT * FROM audit ORDER BY created_at DESC LIMIT 500").all();
  const pageViews = scalar(
    "SELECT COUNT(*) value FROM events WHERE event='page_view' AND detailed_consent=1 AND created_at>=?",
    since,
  );
  const visitors = scalar(
    "SELECT COUNT(DISTINCT visitor_id) value FROM events WHERE detailed_consent=1 AND created_at>=?",
    since,
  );
  const walletConnects = scalar(
    "SELECT COUNT(*) value FROM events WHERE event='wallet_connect' AND detailed_consent=1 AND created_at>=?",
    since,
  );
  const verifiedKyc = scalar("SELECT COUNT(*) value FROM users WHERE kyc_status='Approved'");
  const dailyTraffic = db
    .prepare(
      `SELECT substr(created_at,1,10) day,
              SUM(CASE WHEN event='page_view' THEN 1 ELSE 0 END) pageViews,
              COUNT(DISTINCT visitor_id) visitors,
              SUM(CASE WHEN event='wallet_connect' THEN 1 ELSE 0 END) walletConnects
       FROM events WHERE detailed_consent=1 AND created_at>=? GROUP BY day ORDER BY day`,
    )
    .all(since);
  const topPages = groupedMetric(
    "SELECT path label, COUNT(*) value FROM events WHERE event='page_view' AND detailed_consent=1 AND created_at>=? GROUP BY path ORDER BY value DESC LIMIT 12",
    since,
  );
  const topEvents = groupedMetric(
    "SELECT event label, COUNT(*) value FROM events WHERE detailed_consent=1 AND created_at>=? GROUP BY event ORDER BY value DESC LIMIT 12",
    since,
  );
  const sources = groupedMetric(
    "SELECT COALESCE(NULLIF(source,''),'Diretto') label, COUNT(*) value FROM events WHERE event='page_view' AND detailed_consent=1 AND created_at>=? GROUP BY label ORDER BY value DESC LIMIT 10",
    since,
  );
  const countries = groupedMetric(
    "SELECT COALESCE(NULLIF(country,''),'Non rilevato') label, COUNT(DISTINCT visitor_id) value FROM events WHERE detailed_consent=1 AND created_at>=? GROUP BY label ORDER BY value DESC LIMIT 10",
    since,
  );
  const devices = groupedMetric(
    "SELECT device label, COUNT(DISTINCT visitor_id) value FROM events WHERE detailed_consent=1 AND device IS NOT NULL AND created_at>=? GROUP BY device ORDER BY value DESC",
    since,
  );
  const browsers = groupedMetric(
    "SELECT browser label, COUNT(DISTINCT visitor_id) value FROM events WHERE detailed_consent=1 AND browser IS NOT NULL AND created_at>=? GROUP BY browser ORDER BY value DESC",
    since,
  );
  const operatingSystems = groupedMetric(
    "SELECT os label, COUNT(DISTINCT visitor_id) value FROM events WHERE detailed_consent=1 AND os IS NOT NULL AND created_at>=? GROUP BY os ORDER BY value DESC",
    since,
  );
  const detailedVisitors = db.prepare(
    `WITH ranked AS (
       SELECT visitor_id, wallet, ip_address, browser, device, os, path, country,
              consent_version, created_at,
              COUNT(*) OVER (PARTITION BY visitor_id) page_views,
              ROW_NUMBER() OVER (PARTITION BY visitor_id ORDER BY created_at DESC) row_number
       FROM events
       WHERE event='page_view' AND detailed_consent=1 AND ip_address IS NOT NULL AND created_at>=?
     )
     SELECT visitor_id visitorId,
            COALESCE(wallet, (SELECT e.wallet FROM events e WHERE e.visitor_id=ranked.visitor_id AND e.wallet IS NOT NULL ORDER BY e.created_at DESC LIMIT 1)) wallet,
            ip_address ipAddress, browser, device, os, path, country,
            consent_version consentVersion, created_at lastSeenAt, page_views pageViews
     FROM ranked WHERE row_number=1 ORDER BY created_at DESC LIMIT 500`,
  ).all(since);
  const kycStatuses = groupedMetric(
    "SELECT kyc_status label, COUNT(*) value FROM users GROUP BY kyc_status ORDER BY value DESC",
  );
  const finance = {
    usdcIn: Number(scalar("SELECT COALESCE(SUM(usdc_delta),0) value FROM ledger WHERE usdc_delta>0")),
    usdcOut: Math.abs(
      Number(scalar("SELECT COALESCE(SUM(usdc_delta),0) value FROM ledger WHERE usdc_delta<0")),
    ),
    ashIssued: Math.abs(
      Number(scalar("SELECT COALESCE(SUM(ash_delta),0) value FROM ledger WHERE ash_delta<0")),
    ),
    pending: scalar("SELECT COUNT(*) value FROM ledger WHERE status IN ('pending','queued')"),
  };
  const pool = await readPoolState();

  res.json({
    generatedAt: new Date().toISOString(),
    days,
    config: {
      adminWalletConfigured: Boolean(ADMIN_WALLET),
      kyc: { provider: "Didit", brand: DIDIT_WHITE_LABEL ? "Phoenix" : "Didit", whiteLabel: DIDIT_WHITE_LABEL, enabled: Boolean(DIDIT_API_KEY && DIDIT_WEBHOOK_SECRET) },
      nft: { network: "Base", collection: NFT_COLLECTION_ADDRESS || null },
    },
    overview: {
      users: users.length,
      visitors,
      pageViews,
      walletConnects,
      verifiedKyc,
      quizzes: quizzes.length,
      conversion: visitors ? (walletConnects / visitors) * 100 : 0,
    },
    analytics: {
      dailyTraffic,
      topPages,
      topEvents,
      sources,
      countries,
      devices,
      browsers,
      operatingSystems,
      detailedVisitors,
      detailRetention: "until_withdrawal",
    },
    kycStatuses,
    users,
    quizzes,
    finance,
    ledger,
    audit,
    pool,
  });
});

app.post("/api/admin/quizzes", requireAdmin, (req, res) => {
  const quiz = validateQuiz(req.body);
  if (!quiz.ok) return res.status(400).json({ error: quiz.error });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO quizzes
     (id,title,category,difficulty,reward,status,questions_json,completions,passes,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,0,0,?,?)`,
  ).run(
    id,
    quiz.value.title,
    quiz.value.category,
    quiz.value.difficulty,
    quiz.value.reward,
    quiz.value.status,
    JSON.stringify(quiz.value.questions),
    now,
    now,
  );
  addAudit(shortWallet(req.session.wallet), "Quiz created", id, "OK", quiz.value.title);
  res.status(201).json(mapQuiz(db.prepare("SELECT * FROM quizzes WHERE id=?").get(id)));
});

app.put("/api/admin/quizzes/:id", requireAdmin, (req, res) => {
  const quiz = validateQuiz(req.body);
  if (!quiz.ok) return res.status(400).json({ error: quiz.error });
  const existing = db.prepare("SELECT id FROM quizzes WHERE id=?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "quiz_not_found" });
  db.prepare(
    `UPDATE quizzes SET title=?,category=?,difficulty=?,reward=?,status=?,questions_json=?,updated_at=?
     WHERE id=?`,
  ).run(
    quiz.value.title,
    quiz.value.category,
    quiz.value.difficulty,
    quiz.value.reward,
    quiz.value.status,
    JSON.stringify(quiz.value.questions),
    new Date().toISOString(),
    req.params.id,
  );
  addAudit(shortWallet(req.session.wallet), "Quiz updated", req.params.id, "OK", quiz.value.title);
  res.json(mapQuiz(db.prepare("SELECT * FROM quizzes WHERE id=?").get(req.params.id)));
});

app.delete("/api/admin/quizzes/:id", requireAdmin, (req, res) => {
  const existing = db.prepare("SELECT title FROM quizzes WHERE id=?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "quiz_not_found" });
  db.prepare("DELETE FROM quizzes WHERE id=?").run(req.params.id);
  addAudit(shortWallet(req.session.wallet), "Quiz deleted", req.params.id, "OK", existing.title);
  res.json({ deleted: true });
});

app.patch("/api/admin/users/:wallet", requireAdmin, (req, res) => {
  const wallet = normalizeWallet(req.params.wallet);
  if (!wallet) return res.status(400).json({ error: "invalid_wallet" });
  const status = ["active", "suspended", "review"].includes(req.body?.status)
    ? req.body.status
    : null;
  const risk = ["low", "medium", "high"].includes(req.body?.risk) ? req.body.risk : null;
  if (!status && !risk) return res.status(400).json({ error: "invalid_update" });
  const current = db.prepare("SELECT * FROM users WHERE wallet=?").get(wallet);
  if (!current) return res.status(404).json({ error: "user_not_found" });
  db.prepare("UPDATE users SET status=?, risk=? WHERE wallet=?").run(
    status || current.status,
    risk || current.risk,
    wallet,
  );
  addAudit(shortWallet(req.session.wallet), "User updated", shortWallet(wallet), "OK", `${status || current.status}/${risk || current.risk}`);
  res.json(mapUser(db.prepare("SELECT * FROM users WHERE wallet=?").get(wallet)));
});

app.use(servePublicFiles);

app.use((error, _req, res, _next) => {
  console.error("Unhandled request error", error);
  if (!res.headersSent) res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Phoenix listening on ${PORT}; data=${DATA_DIR}; admin=${ADMIN_WALLET ? "configured" : "locked"}`);
});

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      joined_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      chain_id INTEGER,
      source TEXT,
      kyc_status TEXT NOT NULL DEFAULT 'Not Started',
      kyc_session_id TEXT,
      kyc_updated_at TEXT,
      kyc_summary_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      risk TEXT NOT NULL DEFAULT 'low',
      nft_count INTEGER NOT NULL DEFAULT 0,
      nft_collection TEXT,
      tests_json TEXT NOT NULL DEFAULT '[]',
      quiz_completions INTEGER NOT NULL DEFAULT 0,
      ash_issued TEXT NOT NULL DEFAULT '0',
      usdc_paid TEXT NOT NULL DEFAULT '0'
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      visitor_id TEXT,
      wallet TEXT,
      event TEXT NOT NULL,
      path TEXT,
      referrer TEXT,
      source TEXT,
      user_agent TEXT,
      language TEXT,
      timezone TEXT,
      country TEXT,
      metadata_json TEXT,
      ip_address TEXT,
      browser TEXT,
      device TEXT,
      os TEXT,
      detailed_consent INTEGER NOT NULL DEFAULT 0,
      consent_version TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id);
    CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      reward REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      questions_json TEXT NOT NULL,
      completions INTEGER NOT NULL DEFAULT 0,
      passes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      type TEXT NOT NULL,
      wallet TEXT,
      usdc_delta REAL NOT NULL DEFAULT 0,
      ash_delta REAL NOT NULL DEFAULT 0,
      tx_hash TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      resource TEXT,
      outcome TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS didit_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT,
      wallet TEXT,
      webhook_type TEXT,
      status TEXT,
      payload_hash TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_challenges (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      nonce TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  `);
  ensureColumn("events", "ip_address", "TEXT");
  ensureColumn("events", "browser", "TEXT");
  ensureColumn("events", "device", "TEXT");
  ensureColumn("events", "os", "TEXT");
  ensureColumn("events", "detailed_consent", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("events", "consent_version", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_consent_created ON events(detailed_consent, created_at)");
  db.prepare(
    `UPDATE events SET visitor_id=NULL, wallet=NULL, path=NULL, referrer=NULL, source=NULL,
       user_agent=NULL, language=NULL, timezone=NULL, country=NULL, metadata_json='{}'
     WHERE detailed_consent=0`,
  ).run();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").run(new Date().toISOString());
}

function seedQuizzes() {
  if (scalar("SELECT COUNT(*) value FROM quizzes")) return;
  const now = new Date().toISOString();
  const seeds = [
    ["Bitcoin: dalle origini a oggi", "Crypto", "Media", 35, "published", ["Chi ha creato Bitcoin?", "Qual è il limite massimo di BTC?", "Cos’è l’halving?"]],
    ["Fondamenti della DeFi", "DeFi", "Difficile", 50, "published", ["Cos’è un AMM?", "Come funziona una liquidity pool?"]],
    ["Gaming: storia delle console", "Gaming", "Facile", 20, "published", ["Quale console uscì nel 1994?", "Chi ha creato Mario?"]],
    ["Layer 2 e rollup", "Blockchain", "Difficile", 60, "draft", ["Cos’è un optimistic rollup?", "Cos’è una prova ZK?"]],
  ];
  const insert = db.prepare(
    `INSERT INTO quizzes
     (id,title,category,difficulty,reward,status,questions_json,completions,passes,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,0,0,?,?)`,
  );
  for (const seed of seeds) {
    insert.run(crypto.randomUUID(), seed[0], seed[1], seed[2], seed[3], seed[4], JSON.stringify(seed[5]), now, now);
  }
}

function normalizeWallet(value) {
  if (!value || !isAddress(String(value))) return "";
  try {
    return getAddress(String(value)).toLowerCase();
  } catch {
    return "";
  }
}

function normalizeChainId(value) {
  if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return parseInt(value, 16);
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function upsertUser(wallet, { chainId = null, source = null, lastSeenAt = null } = {}) {
  const now = lastSeenAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO users (wallet,joined_at,last_seen_at,chain_id,source)
     VALUES (?,?,?,?,?)
     ON CONFLICT(wallet) DO UPDATE SET
       last_seen_at=excluded.last_seen_at,
       chain_id=COALESCE(excluded.chain_id,users.chain_id),
       source=COALESCE(users.source,excluded.source)`,
  ).run(wallet, now, now, chainId, source);
}

function recordEvent(req, data) {
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const language = cleanText(metadata.language || req.get("accept-language")?.split(",")[0], 30);
  const timezone = cleanText(metadata.timezone, 80);
  const source = data.source || classifySource(data.referrer);
  const detailedConsent = data.analyticsConsent === true;
  const userAgent = detailedConsent ? cleanText(req.get("user-agent"), 500) : "";
  const ipAddress = detailedConsent ? getClientIp(req) : "";
  db.prepare(
    `INSERT INTO events
     (id,visitor_id,wallet,event,path,referrer,source,user_agent,language,timezone,country,metadata_json,
      ip_address,browser,device,os,detailed_consent,consent_version,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    crypto.randomUUID(),
    data.visitorId || null,
    data.wallet || null,
    data.event,
    data.path || null,
    data.referrer || null,
    source || null,
    userAgent || null,
    language || null,
    timezone || null,
    cleanText(req.get("cf-ipcountry"), 3) || null,
    JSON.stringify(metadata),
    ipAddress || null,
    userAgent ? detectBrowser(userAgent) : null,
    userAgent ? detectDevice(userAgent) : null,
    userAgent ? detectOs(userAgent) : null,
    detailedConsent ? 1 : 0,
    detailedConsent ? cleanText(data.consentVersion, 30) || "analytics-v1" : null,
    new Date().toISOString(),
  );
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = db
    .prepare("SELECT wallet,is_admin,expires_at FROM sessions WHERE token_hash=?")
    .get(sha256(token));
  if (!session || Date.parse(session.expires_at) < Date.now()) return null;
  return session;
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "authentication_required" });
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session?.is_admin) {
    return res.status(403).json({
      error: ADMIN_WALLET ? "admin_required" : "admin_wallet_not_configured",
    });
  }
  req.session = session;
  next();
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function setSessionCookie(res, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`,
  );
}

function validateQuiz(body) {
  const title = cleanText(body?.title, 100);
  const category = cleanText(body?.category, 40);
  const difficulty = cleanText(body?.difficulty, 30);
  const reward = Number(body?.reward);
  const statusAliases = { Bozza: "draft", Pubblicato: "published", Archiviato: "archived" };
  const status = statusAliases[body?.status] || body?.status;
  const questions = Array.isArray(body?.questions)
    ? body.questions.map((question) => cleanText(question, 500)).filter(Boolean).slice(0, 100)
    : [];
  if (!title || !category || !difficulty || !questions.length) return { ok: false, error: "missing_fields" };
  if (!Number.isFinite(reward) || reward < 0 || reward > 1_000_000) return { ok: false, error: "invalid_reward" };
  if (!["draft", "published", "archived"].includes(status)) return { ok: false, error: "invalid_status" };
  return { ok: true, value: { title, category, difficulty, reward, status, questions } };
}

function mapQuiz(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    difficulty: row.difficulty,
    reward: Number(row.reward),
    status: row.status,
    questions: parseJson(row.questions_json, []),
    completions: Number(row.completions || 0),
    passes: Number(row.passes || 0),
    passRate: row.completions ? (Number(row.passes) / Number(row.completions)) * 100 : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUser(row) {
  return {
    wallet: row.wallet,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
    chainId: row.chain_id,
    source: row.source,
    kycStatus: row.kyc_status,
    kycSessionId: row.kyc_session_id,
    kycUpdatedAt: row.kyc_updated_at,
    status: row.status,
    risk: row.risk,
    nftCount: Number(row.nft_count || 0),
    nftCollection: row.nft_collection,
    tests: parseJson(row.tests_json, []),
    quizCompletions: Number(row.quiz_completions || 0),
    ashIssued: Number(row.ash_issued || 0),
    usdcPaid: Number(row.usdc_paid || 0),
  };
}

function addAudit(actor, action, resource, outcome, details) {
  db.prepare(
    "INSERT INTO audit (id,actor,action,resource,outcome,details,created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(
    crypto.randomUUID(),
    cleanText(actor, 100) || "System",
    cleanText(action, 160) || "Event",
    cleanText(resource, 160),
    cleanText(outcome, 30) || "OK",
    cleanText(details, 500),
    new Date().toISOString(),
  );
}

const walletStateCache = new Map();
async function readWalletState(wallet) {
  const cached = walletStateCache.get(wallet);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const fallback = {
    status: "unavailable",
    chainId: 8453,
    nativeEth: null,
    ash: null,
    usdc: null,
    nftCount: null,
    ashAddress: ASH_CONTRACT,
    usdcAddress: USDC_CONTRACT,
    nftCollection: NFT_COLLECTION_ADDRESS || null,
    updatedAt: new Date().toISOString(),
  };
  try {
    const provider = new JsonRpcProvider(BASE_RPC_URL, 8453, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    const balanceAbi = ["function balanceOf(address) view returns (uint256)"];
    const ash = new Contract(ASH_CONTRACT, balanceAbi, provider);
    const usdc = new Contract(USDC_CONTRACT, balanceAbi, provider);
    const nft = NFT_COLLECTION_ADDRESS ? new Contract(NFT_COLLECTION_ADDRESS, balanceAbi, provider) : null;
    const [nativeBalance, ashBalance, usdcBalance, nftBalance] = await Promise.all([
      safeContractCall(() => provider.getBalance(wallet)),
      safeContractCall(() => ash.balanceOf(wallet)),
      safeContractCall(() => usdc.balanceOf(wallet)),
      nft ? safeContractCall(() => nft.balanceOf(wallet)) : null,
    ]);
    const value = {
      ...fallback,
      status: nativeBalance != null || ashBalance != null || usdcBalance != null ? "live" : "unavailable",
      nativeEth: nativeBalance == null ? null : formatUnits(nativeBalance, 18),
      ash: ashBalance == null ? null : formatUnits(ashBalance, 18),
      usdc: usdcBalance == null ? null : formatUnits(usdcBalance, 6),
      nftCount: nftBalance == null ? null : Number(nftBalance),
      updatedAt: new Date().toISOString(),
    };
    walletStateCache.set(wallet, { expiresAt: Date.now() + 30_000, value });
    return value;
  } catch (error) {
    console.error("Base wallet read failed", error?.message || error);
    return fallback;
  }
}

let poolCache = { expiresAt: 0, value: null };
async function readPoolState() {
  if (poolCache.expiresAt > Date.now() && poolCache.value) return poolCache.value;
  const fallback = {
    type: "fixed_rate_swap",
    chainId: 8453,
    status: "unavailable",
    ashAddress: ASH_CONTRACT,
    swapAddress: ASH_SWAP_CONTRACT,
    usdcAddress: USDC_CONTRACT,
    nftCollection: NFT_COLLECTION_ADDRESS || null,
  };
  if (!ASH_CONTRACT || !ASH_SWAP_CONTRACT || !USDC_CONTRACT) return fallback;
  try {
    const provider = new JsonRpcProvider(BASE_RPC_URL, 8453, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    const erc20Abi = [
      "function balanceOf(address) view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
    ];
    const swapAbi = [
      "function ash() view returns (address)",
      "function usdc() view returns (address)",
      "function treasury() view returns (address)",
      "function owner() view returns (address)",
      "function ashPerUsdc() view returns (uint256)",
      "function rate() view returns (uint256)",
    ];
    const ash = new Contract(ASH_CONTRACT, erc20Abi, provider);
    const usdc = new Contract(USDC_CONTRACT, erc20Abi, provider);
    const swap = new Contract(ASH_SWAP_CONTRACT, swapAbi, provider);
    const [swapCode, ashCode, ashBalance, usdcBalance, totalSupply, treasury, owner, rateA, rateB, chainAsh, chainUsdc] =
      await Promise.all([
        provider.getCode(ASH_SWAP_CONTRACT),
        provider.getCode(ASH_CONTRACT),
        ash.balanceOf(ASH_SWAP_CONTRACT),
        usdc.balanceOf(ASH_SWAP_CONTRACT),
        ash.totalSupply(),
        safeContractCall(() => swap.treasury()),
        safeContractCall(() => swap.owner()),
        safeContractCall(() => swap.ashPerUsdc()),
        safeContractCall(() => swap.rate()),
        safeContractCall(() => swap.ash()),
        safeContractCall(() => swap.usdc()),
      ]);
    const treasuryUsdc = treasury ? await safeContractCall(() => usdc.balanceOf(treasury)) : null;
    const value = {
      ...fallback,
      status: swapCode !== "0x" && ashCode !== "0x" ? "live" : "missing_contract",
      verifiedAddresses:
        normalizeWallet(chainAsh || "") === ASH_CONTRACT &&
        normalizeWallet(chainUsdc || "") === USDC_CONTRACT,
      ashReserve: formatUnits(ashBalance, 18),
      usdcReserve: formatUnits(usdcBalance, 6),
      ashTotalSupply: formatUnits(totalSupply, 18),
      treasury: normalizeWallet(treasury || "") || null,
      treasuryUsdc: treasuryUsdc == null ? null : formatUnits(treasuryUsdc, 6),
      owner: normalizeWallet(owner || "") || null,
      ashPerUsdc: rateA != null ? String(rateA) : rateB != null ? String(rateB) : null,
      updatedAt: new Date().toISOString(),
    };
    poolCache = { expiresAt: Date.now() + 30_000, value };
    return value;
  } catch (error) {
    console.error("Base pool read failed", error?.message || error);
    return { ...fallback, error: "rpc_unavailable", updatedAt: new Date().toISOString() };
  }
}

async function safeContractCall(call) {
  try {
    return await call();
  } catch {
    return null;
  }
}

function servePublicFiles(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.originalUrl, PUBLIC_URL).pathname);
  } catch {
    return res.status(400).send("Bad request");
  }
  if (pathname === "/") pathname = "/index.html";
  if (pathname.endsWith("/")) pathname += "index.html";
  const relative = pathname.replace(/^\/+/, "");
  const extension = path.extname(relative).toLowerCase();
  const allowedExtensions = new Set([".html", ".js", ".css", ".png", ".svg", ".jpg", ".jpeg", ".webp", ".ico", ".txt"]);
  const isPublicJson = extension === ".json" && relative.replaceAll("\\", "/").startsWith("data/");
  if (!allowedExtensions.has(extension) && !isPublicJson) return res.status(404).send("Not found");
  const resolved = path.resolve(ROOT, relative);
  if (!resolved.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return res.status(404).send("Not found");
  }
  if (extension === ".html") {
    let html = fs.readFileSync(resolved, "utf8");
    if (relative.replaceAll("\\", "/") === "privacy.html") {
      html = html.replace(/<\/body>/i, '<script src="/privacy-current.js" defer></script></body>');
    }
    if (!html.includes('src="/analytics.js"') && !html.includes("src='/analytics.js'")) {
      html = html.replace(/<\/body>/i, '<script src="/analytics.js" defer></script></body>');
    }
    res.setHeader("Cache-Control", "no-cache");
    return res.type("html").send(html);
  }
  res.setHeader("Cache-Control", extension === ".js" || extension === ".css" ? "no-cache" : "public, max-age=86400");
  res.sendFile(resolved);
}

function cleanText(value, maxLength = 200) {
  if (value == null) return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function cleanPath(value) {
  const pathValue = cleanText(value, 300).split("?")[0];
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 20)) {
    const cleanKey = cleanText(key, 40);
    if (!cleanKey) continue;
    if (["string", "number", "boolean"].includes(typeof entry)) result[cleanKey] = cleanText(entry, 200);
  }
  return result;
}

function classifySource(referrer) {
  if (!referrer) return "Diretto";
  const value = String(referrer).toLowerCase();
  if (/google|bing|duckduckgo|yahoo/.test(value)) return "Ricerca";
  if (/twitter|x\.com|facebook|instagram|tiktok|linkedin|reddit|discord/.test(value)) return "Social";
  try {
    return new URL(referrer).hostname;
  } catch {
    return "Referral";
  }
}

function detectDevice(userAgent = "") {
  if (/ipad/i.test(userAgent)) return "iPad";
  if (/iphone|ipod/i.test(userAgent)) return "iPhone";
  if (/android/i.test(userAgent) && /mobile/i.test(userAgent)) return "Android mobile";
  if (/android|tablet/i.test(userAgent)) return "Tablet Android";
  if (/mobile/i.test(userAgent)) return "Mobile";
  return "Desktop";
}

function detectBrowser(userAgent = "") {
  const patterns = [
    ["Edge", /Edg(?:A|iOS)?\/(\d+)/i],
    ["Opera", /(?:OPR|Opera)\/(\d+)/i],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/i],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+)/i],
    ["Safari", /Version\/(\d+).+Safari\//i],
  ];
  for (const [name, pattern] of patterns) {
    const match = userAgent.match(pattern);
    if (match) return `${name} ${match[1]}`;
  }
  return "Altro";
}

function detectOs(userAgent = "") {
  let match;
  if ((match = userAgent.match(/Windows NT ([\d.]+)/i))) {
    const versions = { "10.0": "Windows 10/11", "6.3": "Windows 8.1", "6.1": "Windows 7" };
    return versions[match[1]] || `Windows ${match[1]}`;
  }
  if ((match = userAgent.match(/Android ([\d.]+)/i))) return `Android ${match[1]}`;
  if ((match = userAgent.match(/(?:iPhone OS|CPU OS) ([\d_]+)/i))) return `iOS ${match[1].replaceAll("_", ".")}`;
  if ((match = userAgent.match(/Mac OS X ([\d_]+)/i))) return `macOS ${match[1].replaceAll("_", ".")}`;
  if (/CrOS/i.test(userAgent)) return "ChromeOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "Altro";
}

function countLabels(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

function groupedMetric(sql, ...params) {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ label: row.label, value: Number(row.value || 0) }));
}

function scalar(sql, ...params) {
  return Number(db.prepare(sql).get(...params)?.value || 0);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clientKey(req) {
  const address = getClientIp(req) || "unknown";
  return sha256(address).slice(0, 20);
}

function getClientIp(req) {
  const flyAddress = cleanText(req.get("fly-client-ip"), 64);
  if (process.env.FLY_APP_NAME && isIP(flyAddress)) return flyAddress;
  const remoteAddress = cleanText(req.socket.remoteAddress, 64).replace(/^::ffff:/, "");
  return isIP(remoteAddress) ? remoteAddress : "";
}

function shortWallet(wallet) {
  return wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "—";
}
