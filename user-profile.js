(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (value, digits = 4) => value == null ? "—" : new Intl.NumberFormat("it-IT", { maximumFractionDigits: digits }).format(Number(value));
  const when = (value) => value ? new Date(value).toLocaleString("it-IT") : "—";
  const short = (value) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const kycLabels = { "Not Started": "Non avviato", "In Progress": "In corso", "Awaiting User": "In attesa", "In Review": "In revisione", Approved: "Verificato", Declined: "Rifiutato", Resubmitted: "Da ripetere", Abandoned: "Abbandonato", Expired: "Scaduto", "Kyc Expired": "KYC scaduto" };
  let profile = null;

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || "request_failed");
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function provider() {
    const ethereum = window.ethereum;
    if (!ethereum) return null;
    if (ethereum.providers?.length) return ethereum.providers.find((item) => item.isMetaMask) || ethereum.providers[0];
    return ethereum;
  }

  async function authenticate() {
    const walletProvider = provider();
    if (!walletProvider) throw new Error("Nessun wallet EVM rilevato.");
    const accounts = await walletProvider.request({ method: "eth_requestAccounts" });
    const wallet = accounts?.[0];
    if (!wallet) throw new Error("Wallet non disponibile.");
    $("authStatus").textContent = "Firma il messaggio nel wallet…";
    const challenge = await api("/api/auth/challenge", { method: "POST", body: JSON.stringify({ wallet }) });
    let signature;
    try {
      signature = await walletProvider.request({ method: "personal_sign", params: [challenge.message, wallet] });
    } catch (error) {
      if (error?.code === 4001) throw new Error("Firma annullata.");
      throw error;
    }
    await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ wallet, signature }) });
    $("authGate").classList.add("hidden");
    await loadProfile();
  }

  function localProgress() {
    const result = { tests: [], quizCompletions: 0, cryptoBest: null, gamingBest: null, localAsh: 0 };
    try {
      const mbti = JSON.parse(localStorage.getItem("phoenixMbtiResult") || "null");
      const bigFive = JSON.parse(localStorage.getItem("phoenixBigFiveResult") || "null");
      if (mbti?.type) result.tests.push(`MBTI: ${mbti.type}`);
      if (bigFive?.scores) result.tests.push(`Big Five: ${Object.entries(bigFive.scores).map(([key, value]) => `${key} ${value}%`).join(" · ")}`);
      const cryptoValue = localStorage.getItem("phoenixQuizCryptoBest");
      const gamingValue = localStorage.getItem("phoenixQuizGamingBest");
      result.cryptoBest = cryptoValue == null ? null : Number(cryptoValue);
      result.gamingBest = gamingValue == null ? null : Number(gamingValue);
      result.localAsh = Number(localStorage.getItem("phoenixQuizAsh") || 0);
      result.quizCompletions = Number(cryptoValue != null) + Number(gamingValue != null);
    } catch {}
    return result;
  }

  async function syncLocalProgress() {
    const local = localProgress();
    $("localCrypto").textContent = local.cryptoBest == null ? "—" : `${fmt(local.cryptoBest, 0)} punti`;
    $("localGaming").textContent = local.gamingBest == null ? "—" : `${fmt(local.gamingBest, 0)} punti`;
    $("localAsh").textContent = fmt(local.localAsh, 0);
    if (!local.tests.length && !local.quizCompletions) {
      $("progressSync").textContent = "Nessun dato locale";
      return;
    }
    try {
      await api("/api/user/progress", { method: "POST", body: JSON.stringify({ tests: local.tests, quizCompletions: local.quizCompletions }) });
      $("progressSync").textContent = "Sincronizzato";
    } catch {
      $("progressSync").textContent = "Non riuscita";
    }
  }

  function badgeClass(value) {
    if (/Approved|Verificato|active|live|confirmed|completed/i.test(value)) return "ok";
    if (/Declined|Rifiutato|suspended|failed/i.test(value)) return "bad";
    return "warn";
  }

  function render() {
    const account = profile.account;
    const kyc = profile.kyc;
    const balances = profile.balances;
    $("walletAddress").textContent = account.wallet;
    $("walletExplorer").href = `https://basescan.org/address/${account.wallet}`;
    $("accountStatus").textContent = account.status === "active" ? "Account attivo" : account.status;
    $("accountStatus").className = `badge ${badgeClass(account.status)}`;
    $("lastSync").textContent = `Ultimo aggiornamento: ${when(profile.generatedAt)}`;
    $("joinedAt").textContent = when(account.joinedAt);
    $("lastSeenAt").textContent = when(account.lastSeenAt);
    $("accountSource").textContent = account.source || "website";
    $("ashBalance").textContent = balances.ash == null ? "—" : `${fmt(balances.ash)} ASH`;
    $("usdcBalance").textContent = balances.usdc == null ? "—" : `${fmt(balances.usdc)} USDC`;
    $("ethBalance").textContent = balances.nativeEth == null ? "—" : `${fmt(balances.nativeEth, 6)} ETH`;
    $("nftCount").textContent = profile.nft.configured ? fmt(profile.nft.count, 0) : "—";
    $("nftStatus").textContent = profile.nft.configured ? "NFT nella collezione Phoenix" : "Collezione non ancora pubblicata";

    const kycLabel = kycLabels[kyc.status] || kyc.status;
    $("kycBadge").textContent = kycLabel;
    $("kycBadge").className = `badge ${badgeClass(kyc.status)}`;
    $("kycUpdated").textContent = when(kyc.updatedAt);
    $("kycButton").textContent = kyc.status === "Approved" ? "Visualizza stato KYC" : /Progress|Awaiting|Review/i.test(kyc.status) ? "Continua KYC" : "Avvia verifica KYC";

    $("ashIssued").textContent = `${fmt(profile.rewards.ashIssued)} ASH`;
    $("usdcPaid").textContent = `${fmt(profile.rewards.usdcPaid)} USDC`;
    $("quizCompletions").textContent = fmt(profile.learning.quizCompletions, 0);
    $("quizBadge").textContent = `${fmt(profile.learning.quizCompletions, 0)} quiz`;
    $("testsList").innerHTML = profile.learning.tests.length
      ? profile.learning.tests.map((test) => `<div class="list-row"><span>Test completato</span><b>${esc(typeof test === "string" ? test : JSON.stringify(test))}</b></div>`).join("")
      : '<div class="empty">Nessun test sincronizzato.</div>';

    $("activityCount").textContent = `${profile.activity.length} operazioni`;
    $("activityBody").innerHTML = profile.activity.length
      ? profile.activity.map((entry) => `<tr><td>${esc(when(entry.createdAt))}</td><td>${esc(entry.event)}</td><td>${esc(entry.type)}</td><td>${entry.usdcDelta ? `${Number(entry.usdcDelta) > 0 ? "+" : ""}${fmt(entry.usdcDelta)} USDC` : "—"}</td><td>${entry.ashDelta ? `${Number(entry.ashDelta) > 0 ? "+" : ""}${fmt(entry.ashDelta)} ASH` : "—"}</td><td>${entry.txHash ? `<a class="wallet" target="_blank" rel="noopener" href="https://basescan.org/tx/${esc(entry.txHash)}">${esc(short(entry.txHash))}</a>` : "—"}</td><td><span class="badge ${badgeClass(entry.status)}">${esc(entry.status)}</span></td></tr>`).join("")
      : '<tr><td colspan="7" class="empty">Nessun pagamento o premio ancora registrato.</td></tr>';
  }

  async function loadProfile() {
    $("refreshBtn").disabled = true;
    try {
      await syncLocalProgress();
      profile = await api("/api/user/profile");
      render();
    } catch (error) {
      if (error.status === 401 || error.status === 403) $("authGate").classList.remove("hidden");
      else throw error;
    } finally {
      $("refreshBtn").disabled = false;
    }
  }

  async function boot() {
    try {
      const me = await api("/api/auth/me");
      if (!me.authenticated) throw new Error("authentication_required");
      $("authGate").classList.add("hidden");
      await loadProfile();
    } catch {
      $("authStatus").textContent = "Collega e firma con il tuo wallet.";
      $("authGate").classList.remove("hidden");
    }
  }

  $("connectBtn").addEventListener("click", async () => {
    $("connectBtn").disabled = true;
    try { await authenticate(); }
    catch (error) { $("authStatus").textContent = error.message || "Accesso non riuscito."; }
    finally { $("connectBtn").disabled = false; }
  });
  $("refreshBtn").addEventListener("click", () => loadProfile().catch((error) => alert(error.message)));
  $("logoutBtn").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); profile = null; $("authStatus").textContent = "Sessione terminata."; $("authGate").classList.remove("hidden"); });
  boot();
})();
