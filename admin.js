(() => {
  const apiBase = (window.PHOENIX_ADMIN_API_URL || window.location.origin).replace(/\/$/, "");
  let dashboard = null;
  let currentWallet = "";
  const titles = {
    overview: "Panoramica operativa",
    users: "Utenti iscritti",
    quizzes: "Gestione quiz",
    analytics: "Analytics visitatori",
    finance: "Finanze e ricompense",
    pool: "Riserve ASH",
    audit: "Registro attività",
  };
  const kycLabels = {
    "Not Started": "Non avviato",
    "In Progress": "In corso",
    "Awaiting User": "In attesa utente",
    "In Review": "In revisione",
    Approved: "Verificato",
    Declined: "Rifiutato",
    Resubmitted: "Da ripetere",
    Abandoned: "Abbandonato",
    Expired: "Scaduto",
    "Kyc Expired": "KYC scaduto",
  };
  const statusLabels = { active: "Attivo", suspended: "Sospeso", review: "Revisione" };
  const riskLabels = { low: "Basso", medium: "Medio", high: "Alto" };
  const quizLabels = { draft: "Bozza", published: "Pubblicato", archived: "Archiviato" };

  const $ = (id) => document.getElementById(id);
  const fmt = (value, digits = 0) => new Intl.NumberFormat("it-IT", { maximumFractionDigits: digits }).format(Number(value || 0));
  const usd = (value) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value || 0));
  const when = (value) => (value ? new Date(value).toLocaleString("it-IT") : "—");
  const short = (wallet) => (wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "—");
  const periodLabel = () => dashboard?.days === "all" ? "tutto lo storico" : `${dashboard?.days || 30} giorni`;
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const badge = (text) => {
    const value = String(text || "—");
    const cls = /Verificato|Attivo|Confermato|Erogato|Pubblicato|OK|live/i.test(value)
      ? "ok"
      : /Rifiutato|Rischio|Alto|Errore|Declined|missing|unavailable/i.test(value)
        ? "bad"
        : /revisione|Bozza|Medio|Sospeso|attesa|pending|locked/i.test(value)
          ? "warn"
          : "info";
    return `<span class="badge ${cls}">${esc(value)}</span>`;
  };

  async function api(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      credentials: "include",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) showGate(body.error);
      const error = new Error(body.error || "request_failed");
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  function walletProvider() {
    const ethereum = window.ethereum;
    if (!ethereum) return null;
    if (ethereum.providers?.length) return ethereum.providers.find((provider) => provider.isMetaMask) || ethereum.providers[0];
    return ethereum;
  }

  async function authenticateAdmin() {
    const provider = walletProvider();
    if (!provider) throw new Error("Nessun wallet EVM rilevato.");
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const wallet = accounts?.[0];
    if (!wallet) throw new Error("Wallet non disponibile.");
    $("authStatus").textContent = "Firma il messaggio nel wallet…";
    const challenge = await api("/api/auth/challenge", { method: "POST", body: JSON.stringify({ wallet }) });
    let signature;
    try {
      signature = await provider.request({ method: "personal_sign", params: [challenge.message, wallet] });
    } catch (error) {
      if (error?.code === 4001) throw new Error("Firma annullata.");
      throw error;
    }
    const verified = await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ wallet, signature }) });
    if (!verified.admin) {
      await api("/api/auth/logout", { method: "POST" }).catch(() => {});
      throw new Error("Questo wallet non è autorizzato come amministratore.");
    }
    currentWallet = verified.wallet;
    hideGate();
    await loadDashboard();
  }

  function showGate(reason = "") {
    $("authGate").classList.remove("hidden");
    $("authStatus").textContent = reason === "admin_wallet_not_configured"
      ? "Accesso bloccato: configura un wallet amministratore sicuro nei secrets di Fly."
      : "Collega e firma con il wallet amministratore.";
  }

  function hideGate() {
    $("authGate").classList.add("hidden");
  }

  async function boot() {
    try {
      const me = await api("/api/auth/me");
      if (!me.admin) return showGate();
      currentWallet = me.wallet;
      hideGate();
      await loadDashboard();
    } catch {
      showGate();
    }
  }

  async function loadDashboard() {
    $("refreshBtn").disabled = true;
    try {
      dashboard = await api(`/api/admin/dashboard?days=${$("period").value}`);
      renderAll();
      $("lastSync").textContent = `Ultimo aggiornamento: ${when(dashboard.generatedAt)}`;
      $("sourceStatus").textContent = "Database Phoenix + Base RPC";
      $("modeBadge").textContent = "DATI REALI";
      $("modeBadge").style.color = "#7ce8aa";
      $("systemNotice").classList.toggle("hidden", dashboard.config.kyc.enabled);
    } finally {
      $("refreshBtn").disabled = false;
    }
  }

  function setKpis(id, items) {
    $(id).innerHTML = items.map((item) => `<article class="kpi"><div class="label">${esc(item[0])}</div><div class="value">${item[1]}</div><div class="trend ${item[3] || ""}">${esc(item[2] || "")}</div></article>`).join("");
  }

  function metricRows(id, items) {
    const max = Math.max(1, ...items.map((item) => Number(item.value || item[1] || 0)));
    $(id).innerHTML = items.length
      ? items.map((item) => {
          const label = item.label ?? item[0];
          const value = Number(item.value ?? item[1] ?? 0);
          const display = item.display ?? item[2] ?? fmt(value);
          return `<div class="metric-row"><span title="${esc(label)}">${esc(label)}</span><div class="progress"><span style="width:${Math.max(2, (value / max) * 100)}%"></span></div><b>${esc(display)}</b></div>`;
        }).join("")
      : '<div class="empty">Nessun dato nel periodo.</div>';
  }

  function renderOverview() {
    const overview = dashboard.overview;
    const finance = dashboard.finance;
    $("trafficPeriod").textContent = periodLabel();
    setKpis("overviewKpis", [
      ["Visitatori unici", fmt(overview.visitors), periodLabel()],
      ["Visualizzazioni", fmt(overview.pageViews), "page view registrate"],
      ["Wallet iscritti", fmt(overview.users), "wallet unici"],
      ["Conversione wallet", `${fmt(overview.conversion, 1)}%`, "wallet connect / visitatori"],
      ["KYC verificati", fmt(overview.verifiedKyc), "stato Didit Approved"],
      ["Quiz gestiti", fmt(overview.quizzes), "pubblicati e bozze"],
      ["USDC incassati", usd(finance.usdcIn), "ledger tornei"],
      ["ASH erogate", fmt(finance.ashIssued, 2), "ledger ricompense"],
    ]);
    const traffic = dashboard.analytics.dailyTraffic;
    const max = Math.max(1, ...traffic.map((row) => Number(row.pageViews || 0)));
    $("trafficBars").innerHTML = traffic.length
      ? traffic.map((row) => `<div class="bar" style="height:${Math.max(3, Number(row.pageViews || 0) / max * 100)}%" data-value="${esc(row.day)} · ${fmt(row.pageViews)} visite"></div>`).join("")
      : '<div class="empty">I dati inizieranno ad apparire con le visite su Fly.</div>';
    const sourceTotal = Math.max(1, dashboard.analytics.sources.reduce((sum, row) => sum + row.value, 0));
    document.querySelector(".legend").innerHTML = dashboard.analytics.sources.slice(0, 6).map((row, index) => `<span style="--c:${["#e33b52", "#ad263d", "#812239", "#5c2834", "#3a282e", "#2b2024"][index]}">${esc(row.label)} · ${fmt(row.value / sourceTotal * 100, 1)}%</span>`).join("") || "Nessuna sorgente";
    const visitors = Math.max(overview.visitors, 1);
    const users = overview.users;
    $("funnel").innerHTML = [
      ["Visitatori", 100, overview.visitors],
      ["Wallet collegati", Math.min(100, users / visitors * 100), users],
      ["KYC approvati", Math.min(100, overview.verifiedKyc / visitors * 100), overview.verifiedKyc],
    ].map((item) => `<div style="width:${Math.max(20, item[1])}%">${esc(item[0])} · ${fmt(item[2])}</div>`).join("");
    metricRows("opsMetrics", [
      { label: "Backend", value: 100, display: "Operativo" },
      { label: "Didit", value: dashboard.config.kyc.enabled ? 100 : 15, display: dashboard.config.kyc.enabled ? "Operativo" : "Webhook da attivare" },
      { label: "Base RPC", value: dashboard.pool.status === "live" ? 100 : 20, display: dashboard.pool.status },
      { label: "NFT Base", value: dashboard.config.nft.collection ? 100 : 10, display: dashboard.config.nft.collection ? "Configurato" : "In attesa" },
    ]);
  }

  function renderUsers() {
    const query = $("userSearch").value.toLowerCase();
    const kyc = $("kycFilter").value;
    const nft = $("nftFilter").value;
    const status = $("statusFilter").value;
    const rows = dashboard.users.filter((user) => {
      const localizedKyc = kycLabels[user.kycStatus] || user.kycStatus;
      const localizedStatus = statusLabels[user.status] || user.status;
      return (!query || JSON.stringify(user).toLowerCase().includes(query))
        && (!kyc || localizedKyc === kyc)
        && (!status || localizedStatus === status)
        && (!nft || (nft === "yes" ? user.nftCount > 0 : user.nftCount === 0));
    });
    $("userCountBadge").textContent = `${rows.length} visualizzati`;
    $("usersBody").innerHTML = rows.length ? rows.map((user) => `<tr><td class="wallet" title="${esc(user.wallet)}">${esc(short(user.wallet))}</td><td>${esc(when(user.joinedAt))}</td><td>${esc(when(user.lastSeenAt))}</td><td>${badge(kycLabels[user.kycStatus] || user.kycStatus)}</td><td>${fmt(user.nftCount)}</td><td>${esc(user.tests.length ? user.tests.join(", ") : "Nessuno")}</td><td>${fmt(user.quizCompletions)}</td><td>${fmt(user.ashIssued, 2)}</td><td>${usd(user.usdcPaid)}</td><td>${badge(statusLabels[user.status] || user.status)}</td><td><button class="action" data-user="${esc(user.wallet)}">Dettagli</button></td></tr>`).join("") : '<tr><td colspan="11" class="empty">Nessun utente corrisponde ai filtri.</td></tr>';
  }

  function renderQuizzes() {
    const query = $("quizSearch").value.toLowerCase();
    const status = $("quizStatus").value;
    const category = $("quizCategory").value;
    const rows = dashboard.quizzes.filter((quiz) => (!query || quiz.title.toLowerCase().includes(query)) && (!status || quizLabels[quiz.status] === status) && (!category || quiz.category === category));
    $("quizBody").innerHTML = rows.length ? rows.map((quiz) => `<tr><td><strong>${esc(quiz.title)}</strong></td><td>${esc(quiz.category)}</td><td>${esc(quiz.difficulty)}</td><td>${fmt(quiz.questions.length)}</td><td>${fmt(quiz.reward, 2)}</td><td>${fmt(quiz.completions)}</td><td>${fmt(quiz.passRate, 1)}%</td><td>${badge(quizLabels[quiz.status] || quiz.status)}</td><td><button class="action" data-edit="${esc(quiz.id)}">Modifica</button> · <button class="action btn-danger" data-delete="${esc(quiz.id)}">Elimina</button></td></tr>`).join("") : '<tr><td colspan="9" class="empty">Nessun quiz corrisponde ai filtri.</td></tr>';
  }

  function renderAnalytics() {
    const overview = dashboard.overview;
    const days = periodLabel();
    const detailed = dashboard.analytics.detailedVisitors || [];
    setKpis("analyticsKpis", [
      ["Visualizzazioni", fmt(overview.pageViews), days],
      ["Visitatori", fmt(overview.visitors), "consenso analytics"],
      ["Wallet connect", fmt(overview.walletConnects), "eventi"],
      ["Conversione", `${fmt(overview.conversion, 1)}%`, "wallet / visitatori"],
      ["Utenti registrati", fmt(overview.users), "totale storico"],
      ["Consensi dettagliati", fmt(detailed.length), "IP visibili nel periodo"],
      ["Dispositivi", fmt(dashboard.analytics.devices.length), "categorie"],
      ["Sorgenti", fmt(dashboard.analytics.sources.length), "canali rilevati"],
    ]);
    metricRows("pagesMetrics", dashboard.analytics.topPages);
    metricRows("deviceMetrics", [...dashboard.analytics.devices, ...dashboard.analytics.browsers, ...(dashboard.analytics.operatingSystems || [])]);
    metricRows("countryMetrics", dashboard.analytics.countries);
    metricRows("eventMetrics", dashboard.analytics.topEvents);
    populateVisitFilter("visitBrowser", "Browser: tutti", detailed.map((visit) => visit.browser));
    populateVisitFilter("visitDevice", "Dispositivo: tutti", detailed.map((visit) => visit.device));
    $("detailRetention").textContent = "IP e dati tecnici senza scadenza automatica; cancellati su revoca";
    renderDetailedVisitors();
  }

  function populateVisitFilter(id, label, values) {
    const select = $(id);
    const current = select.value;
    const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "it"));
    select.innerHTML = `<option value="">${esc(label)}</option>${options.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;
    if (options.includes(current)) select.value = current;
  }

  function renderDetailedVisitors() {
    const search = $("visitSearch").value.trim().toLowerCase();
    const browser = $("visitBrowser").value;
    const device = $("visitDevice").value;
    const rows = (dashboard.analytics.detailedVisitors || []).filter((visit) => {
      const haystack = [visit.ipAddress, visit.wallet, visit.visitorId, visit.path, visit.browser, visit.device, visit.os].join(" ").toLowerCase();
      return (!search || haystack.includes(search)) && (!browser || visit.browser === browser) && (!device || visit.device === device);
    });
    $("detailedVisitorCount").textContent = `${fmt(rows.length)} consensi`;
    $("visitorsDetailBody").innerHTML = rows.length
      ? rows.map((visit) => `<tr><td>${esc(when(visit.lastSeenAt))}</td><td class="wallet">${esc(visit.ipAddress || "—")}</td><td>${esc(visit.browser || "—")}</td><td>${esc(visit.os || "—")}</td><td>${esc(visit.device || "—")}</td><td title="${esc(visit.path || "—")}">${esc(visit.path || "—")}</td><td>${fmt(visit.pageViews)}</td><td class="wallet" title="${esc(visit.wallet || visit.visitorId || "")}">${esc(visit.wallet ? short(visit.wallet) : short(visit.visitorId))}</td><td>${badge("Confermato")}</td></tr>`).join("")
      : '<tr><td colspan="9" class="empty">Nessun visitatore ha ancora accettato le analytics dettagliate nel periodo.</td></tr>';
  }

  function renderFinance() {
    const finance = dashboard.finance;
    setKpis("financeKpis", [
      ["USDC incassati", usd(finance.usdcIn), "ledger tornei"],
      ["Premi USDC", usd(finance.usdcOut), "uscite registrate"],
      ["USDC netti", usd(finance.usdcIn - finance.usdcOut), "saldo ledger"],
      ["ASH erogate", fmt(finance.ashIssued, 2), "ricompense registrate"],
      ["Operazioni pendenti", fmt(finance.pending), "coda ledger"],
      ["Riserva ASH swap", fmt(dashboard.pool.ashReserve, 2), "dato Base"],
      ["Riserva USDC swap", usd(dashboard.pool.usdcReserve), "dato Base"],
      ["USDC treasury", dashboard.pool.treasuryUsdc == null ? "—" : usd(dashboard.pool.treasuryUsdc), "saldo on-chain"],
    ]);
    $("financeBody").innerHTML = dashboard.ledger.length ? dashboard.ledger.map((entry) => `<tr><td>${esc(when(entry.created_at))}</td><td>${esc(entry.event)}</td><td>${esc(entry.type)}</td><td class="wallet">${esc(entry.wallet ? short(entry.wallet) : entry.tx_hash ? short(entry.tx_hash) : "—")}</td><td class="${entry.usdc_delta < 0 ? "ledger-negative" : entry.usdc_delta > 0 ? "ledger-positive" : ""}">${entry.usdc_delta ? `${entry.usdc_delta > 0 ? "+" : ""}${fmt(entry.usdc_delta, 2)} USDC` : "—"}</td><td class="${entry.ash_delta < 0 ? "ledger-negative" : entry.ash_delta > 0 ? "ledger-positive" : ""}">${entry.ash_delta ? `${entry.ash_delta > 0 ? "+" : ""}${fmt(entry.ash_delta, 2)} ASH` : "—"}</td><td>${badge(entry.status)}</td></tr>`).join("") : '<tr><td colspan="7" class="empty">Nessun pagamento torneo o premio è stato ancora registrato.</td></tr>';
  }

  function renderPool() {
    const pool = dashboard.pool;
    const poolStatus = $("poolStatus");
    poolStatus.textContent = pool.status === "live" ? "Base mainnet · live" : `Base · ${pool.status}`;
    poolStatus.className = `badge ${pool.status === "live" ? "ok" : "bad"}`;
    $("poolCards").innerHTML = [
      ["Tipo", "Swap a tasso fisso"],
      ["Tasso", pool.ashPerUsdc ? `1 USDC = ${esc(pool.ashPerUsdc)} ASH` : "Non leggibile"],
      ["Riserva ASH", pool.ashReserve == null ? "—" : fmt(pool.ashReserve, 4)],
      ["Riserva USDC", pool.usdcReserve == null ? "—" : fmt(pool.usdcReserve, 4)],
      ["USDC treasury", pool.treasuryUsdc == null ? "—" : fmt(pool.treasuryUsdc, 4)],
      ["Supply ASH", pool.ashTotalSupply == null ? "—" : fmt(pool.ashTotalSupply, 2)],
      ["Contratto ASH", `<a class="wallet" target="_blank" rel="noopener" href="https://basescan.org/address/${esc(pool.ashAddress)}">${esc(short(pool.ashAddress))}</a>`],
      ["Contratto swap", `<a class="wallet" target="_blank" rel="noopener" href="https://basescan.org/address/${esc(pool.swapAddress)}">${esc(short(pool.swapAddress))}</a>`],
      ["Ultimo dato", esc(when(pool.updatedAt))],
    ].map((item) => `<div class="pool-card"><small>${esc(item[0])}</small><strong>${item[1]}</strong></div>`).join("");
    metricRows("reserveMetrics", [
      { label: "ASH nello swap", value: Number(pool.ashReserve || 0), display: fmt(pool.ashReserve, 2) },
      { label: "USDC nello swap", value: Number(pool.usdcReserve || 0), display: fmt(pool.usdcReserve, 2) },
      { label: "USDC treasury", value: Number(pool.treasuryUsdc || 0), display: fmt(pool.treasuryUsdc, 2) },
    ]);
    metricRows("riskMetrics", [
      { label: "Bytecode", value: pool.status === "live" ? 100 : 0, display: pool.status === "live" ? "Presente" : "Errore" },
      { label: "Token associati", value: pool.verifiedAddresses ? 100 : 0, display: pool.verifiedAddresses ? "Verificati" : "Da verificare" },
      { label: "NFT Base", value: dashboard.config.nft.collection ? 100 : 0, display: dashboard.config.nft.collection ? "Configurato" : "In attesa" },
    ]);
  }

  function renderAudit() {
    $("auditBody").innerHTML = dashboard.audit.length ? dashboard.audit.map((entry) => `<tr><td>${esc(when(entry.created_at))}</td><td class="wallet">${esc(entry.actor)}</td><td>${esc(entry.action)}</td><td>${esc(entry.resource || "—")}</td><td>${badge(entry.outcome)}</td><td>${esc(entry.details || "—")}</td></tr>`).join("") : '<tr><td colspan="6" class="empty">Il registro è vuoto.</td></tr>';
  }

  function renderAll() {
    renderOverview();
    renderUsers();
    renderQuizzes();
    renderAnalytics();
    renderFinance();
    renderPool();
    renderAudit();
  }

  function openQuiz(id) {
    const quiz = dashboard.quizzes.find((item) => item.id === id);
    $("quizDialogTitle").textContent = quiz ? "Modifica quiz" : "Nuovo quiz";
    $("quizId").value = quiz?.id || "";
    $("quizTitle").value = quiz?.title || "";
    $("quizCat").value = quiz?.category || "Crypto";
    $("quizDifficulty").value = quiz?.difficulty || "Media";
    $("quizReward").value = quiz?.reward ?? 25;
    $("quizState").value = quizLabels[quiz?.status] || "Bozza";
    $("quizQuestions").value = (quiz?.questions || []).join("\n");
    $("quizDialog").showModal();
  }

  function showUser(wallet) {
    const user = dashboard.users.find((item) => item.wallet === wallet);
    if (!user) return;
    $("userDetail").innerHTML = `<div class="kpis" style="grid-template-columns:repeat(2,1fr)"><article class="kpi"><div class="label">Wallet</div><div class="value wallet" style="font-size:.8rem">${esc(user.wallet)}</div></article><article class="kpi"><div class="label">Stato</div><div class="value">${badge(statusLabels[user.status] || user.status)}</div></article><article class="kpi"><div class="label">KYC Didit</div><div class="value">${badge(kycLabels[user.kycStatus] || user.kycStatus)}</div></article><article class="kpi"><div class="label">Rischio</div><div class="value">${badge(riskLabels[user.risk] || user.risk)}</div></article></div><div class="metric-list"><div><b>Iscritto:</b> ${esc(when(user.joinedAt))}</div><div><b>Ultima attività:</b> ${esc(when(user.lastSeenAt))}</div><div><b>Sessione KYC:</b> ${esc(user.kycSessionId || "—")}</div><div><b>NFT Base:</b> ${fmt(user.nftCount)}</div><div><b>Test:</b> ${esc(user.tests.join(", ") || "Nessuno")}</div><div><b>Quiz:</b> ${fmt(user.quizCompletions)}</div><div><b>ASH erogate:</b> ${fmt(user.ashIssued, 2)}</div><div><b>USDC versati:</b> ${usd(user.usdcPaid)}</div></div><div class="dialog-actions"><button class="btn" data-user-status="active" data-wallet="${esc(user.wallet)}">Attiva</button><button class="btn" data-user-status="review" data-wallet="${esc(user.wallet)}">Revisione</button><button class="btn btn-danger" data-user-status="suspended" data-wallet="${esc(user.wallet)}">Sospendi</button></div>`;
    $("userDialog").showModal();
  }

  async function updateUser(wallet, status) {
    await api(`/api/admin/users/${wallet}`, { method: "PATCH", body: JSON.stringify({ status }) });
    $("userDialog").close();
    await loadDashboard();
  }

  function exportCsv() {
    if (!dashboard) return;
    const view = document.querySelector("[data-view].active")?.dataset.view;
    let rows;
    if (view === "users") rows = [["wallet", "joined_at", "last_seen_at", "kyc", "nft", "tests", "quiz", "ash", "usdc", "status", "risk"], ...dashboard.users.map((user) => [user.wallet, user.joinedAt, user.lastSeenAt, user.kycStatus, user.nftCount, user.tests.join(";"), user.quizCompletions, user.ashIssued, user.usdcPaid, user.status, user.risk])];
    else if (view === "quizzes") rows = [["id", "title", "category", "difficulty", "questions", "reward", "status", "completions", "pass_rate"], ...dashboard.quizzes.map((quiz) => [quiz.id, quiz.title, quiz.category, quiz.difficulty, quiz.questions.length, quiz.reward, quiz.status, quiz.completions, quiz.passRate])];
    else if (view === "analytics") rows = [["last_seen_at", "ip", "browser", "os", "device", "path", "page_views", "wallet", "visitor_id", "consent_version"], ...(dashboard.analytics.detailedVisitors || []).map((visit) => [visit.lastSeenAt, visit.ipAddress, visit.browser, visit.os, visit.device, visit.path, visit.pageViews, visit.wallet, visit.visitorId, visit.consentVersion])];
    else rows = [["metric", "value"], ["users", dashboard.overview.users], ["visitors", dashboard.overview.visitors], ["page_views", dashboard.overview.pageViews], ["usdc_in", dashboard.finance.usdcIn], ["ash_issued", dashboard.finance.ashIssued], ["ash_reserve", dashboard.pool.ashReserve], ["usdc_reserve", dashboard.pool.usdcReserve]];
    const csv = rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = `phoenix-admin-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  $("connectAdminBtn").addEventListener("click", async () => {
    $("connectAdminBtn").disabled = true;
    try {
      await authenticateAdmin();
    } catch (error) {
      $("authStatus").textContent = error.message || "Accesso non riuscito.";
    } finally {
      $("connectAdminBtn").disabled = false;
    }
  });
  document.querySelectorAll(".nav button").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".nav button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    $(`view-${button.dataset.view}`).classList.add("active");
    $("pageTitle").textContent = titles[button.dataset.view];
  }));
  ["userSearch", "kycFilter", "nftFilter", "statusFilter"].forEach((id) => $(id).addEventListener("input", () => dashboard && renderUsers()));
  ["quizSearch", "quizStatus", "quizCategory"].forEach((id) => $(id).addEventListener("input", () => dashboard && renderQuizzes()));
  ["visitSearch", "visitBrowser", "visitDevice"].forEach((id) => $(id).addEventListener("input", () => dashboard && renderDetailedVisitors()));
  $("usersBody").addEventListener("click", (event) => { if (event.target.dataset.user) showUser(event.target.dataset.user); });
  $("userDetail").addEventListener("click", (event) => { if (event.target.dataset.userStatus) updateUser(event.target.dataset.wallet, event.target.dataset.userStatus).catch((error) => alert(error.message)); });
  $("quizBody").addEventListener("click", async (event) => {
    if (event.target.dataset.edit) openQuiz(event.target.dataset.edit);
    if (event.target.dataset.delete && confirm("Eliminare questo quiz?")) {
      await api(`/api/admin/quizzes/${event.target.dataset.delete}`, { method: "DELETE" });
      await loadDashboard();
    }
  });
  $("newQuizBtn").addEventListener("click", () => openQuiz());
  $("quizForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("quizId").value;
    const payload = {
      title: $("quizTitle").value.trim(),
      category: $("quizCat").value,
      difficulty: $("quizDifficulty").value,
      reward: Number($("quizReward").value) || 0,
      status: $("quizState").value,
      questions: $("quizQuestions").value.split("\n").map((line) => line.trim()).filter(Boolean),
    };
    await api(id ? `/api/admin/quizzes/${id}` : "/api/admin/quizzes", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
    $("quizDialog").close();
    await loadDashboard();
  });
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(button.dataset.close).close()));
  $("refreshBtn").addEventListener("click", () => loadDashboard().catch((error) => alert(error.message)));
  $("period").addEventListener("change", () => loadDashboard().catch((error) => alert(error.message)));
  $("exportBtn").addEventListener("click", exportCsv);
  boot();
})();
