import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet } from "ethers";

const port = 8091;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-smoke-"));
const adminWallet = Wallet.createRandom();
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    ADMIN_WALLET: adminWallet.address,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk; });

async function waitUntilReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Server did not become ready");
}

try {
  await waitUntilReady();
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json());
  const config = await fetch(`http://127.0.0.1:${port}/api/config`).then((response) => response.json());
  const home = await fetch(`http://127.0.0.1:${port}/`).then(async (response) => ({ status: response.status, html: await response.text() }));
  const kyc = await fetch(`http://127.0.0.1:${port}/kyc.html`);
  const mbtiData = await fetch(`http://127.0.0.1:${port}/data/mbti-characters.json`);
  const privatePackage = await fetch(`http://127.0.0.1:${port}/package.json`);
  const challenge = await fetch(`http://127.0.0.1:${port}/api/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: adminWallet.address }),
  }).then((response) => response.json());
  const unauthenticatedAdmin = await fetch(`http://127.0.0.1:${port}/api/admin/dashboard`);
  const signature = await adminWallet.signMessage(challenge.message);
  const verifiedResponse = await fetch(`http://127.0.0.1:${port}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: adminWallet.address, signature }),
  });
  const verified = await verifiedResponse.json();
  const cookie = verifiedResponse.headers.get("set-cookie")?.split(";")[0] || "";
  const admin = await fetch(`http://127.0.0.1:${port}/api/admin/dashboard`, {
    headers: { Cookie: cookie },
  });
  const adminDashboard = await admin.clone().json();
  const createdQuiz = await fetch(`http://127.0.0.1:${port}/api/admin/quizzes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      title: "Smoke quiz",
      category: "Crypto",
      difficulty: "Facile",
      reward: 5,
      status: "draft",
      questions: ["Test?"],
    }),
  });
  const results = {
    health: health.ok,
    chain: config.chain.id,
    home: home.status,
    analyticsInjected: home.html.includes("/analytics.js"),
    kyc: kyc.status,
    publicData: mbtiData.status,
    packageHidden: privatePackage.status,
    challenge: Boolean(challenge.message),
    unauthenticatedAdmin: unauthenticatedAdmin.status,
    adminAuthenticated: verified.admin === true && admin.status === 200,
    quizCrud: createdQuiz.status === 201,
    poolStatus: adminDashboard.pool?.status,
    poolAddressesVerified: adminDashboard.pool?.verifiedAddresses,
  };
  console.log(JSON.stringify(results));
  if (!results.health || results.chain !== 8453 || results.home !== 200 || !results.analyticsInjected || results.kyc !== 200 || results.publicData !== 200 || results.packageHidden !== 404 || !results.challenge || results.unauthenticatedAdmin !== 403 || !results.adminAuthenticated || !results.quizCrud) {
    process.exitCode = 1;
  }
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  const resolvedTemp = path.resolve(os.tmpdir());
  const resolvedData = path.resolve(dataDir);
  if (resolvedData.startsWith(`${resolvedTemp}${path.sep}phoenix-smoke-`)) {
    fs.rmSync(resolvedData, { recursive: true, force: true });
  }
  if (stderr) process.stderr.write(stderr);
}
