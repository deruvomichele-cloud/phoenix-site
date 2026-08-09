(() => {
  const visitorKey = "phoenixVisitorId";
  const consentKey = "phoenixAnalyticsConsent";
  const consentVersion = "analytics-v1";
  const isAdmin = location.pathname.endsWith("/admin.html");
  let visitorId = "";
  let pageViewSent = false;

  function storedConsent() {
    try {
      return localStorage.getItem(consentKey) || "";
    } catch {
      return "";
    }
  }

  function hasDetailedConsent() {
    return storedConsent() === `granted:${consentVersion}`;
  }

  function ensureVisitorId() {
    if (!hasDetailedConsent()) return "";
    if (visitorId) return visitorId;
    try {
      visitorId = localStorage.getItem(visitorKey) || "";
      if (!visitorId) {
        visitorId = crypto.randomUUID();
        localStorage.setItem(visitorKey, visitorId);
      }
    } catch {
      visitorId = crypto.randomUUID();
    }
    return visitorId;
  }

  function campaignSource() {
    const params = new URLSearchParams(location.search);
    return params.get("utm_source") || "";
  }

  function event(name, metadata = {}) {
    if (isAdmin || !hasDetailedConsent()) return false;
    const payload = JSON.stringify({
      event: name,
      visitorId: ensureVisitorId(),
      wallet: window.phoenixConnectedWallet || "",
      path: location.pathname,
      referrer: document.referrer,
      source: campaignSource(),
      analyticsConsent: true,
      consentVersion,
      metadata: {
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: `${screen.width}x${screen.height}`,
        ...metadata,
      },
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/events", new Blob([payload], { type: "application/json" }));
      return true;
    }
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
    return true;
  }

  function sendPageView() {
    if (pageViewSent || !hasDetailedConsent()) return;
    pageViewSent = true;
    event("page_view", { title: document.title });
  }

  function setConsent(granted) {
    if (granted) {
      try { localStorage.setItem(consentKey, `granted:${consentVersion}`); } catch {}
      ensureVisitorId();
      event("consent_granted", { version: consentVersion });
      sendPageView();
      document.dispatchEvent(new CustomEvent("phoenix:analytics-consent", { detail: { granted: true } }));
    } else {
      const withdrawnVisitorId = hasDetailedConsent() ? ensureVisitorId() : "";
      if (withdrawnVisitorId) {
        const withdrawal = JSON.stringify({ visitorId: withdrawnVisitorId });
        if (navigator.sendBeacon) navigator.sendBeacon("/api/analytics/consent/withdraw", new Blob([withdrawal], { type: "application/json" }));
        else fetch("/api/analytics/consent/withdraw", { method: "POST", headers: { "Content-Type": "application/json" }, body: withdrawal, keepalive: true }).catch(() => {});
      }
      try {
        localStorage.setItem(consentKey, `denied:${consentVersion}`);
        localStorage.removeItem(visitorKey);
      } catch {}
      visitorId = "";
      document.dispatchEvent(new CustomEvent("phoenix:analytics-consent", { detail: { granted: false } }));
    }
    document.getElementById("phoenix-consent")?.remove();
  }

  function showConsent() {
    document.getElementById("phoenix-consent")?.remove();
    const italian = (document.documentElement.lang || navigator.language || "it").toLowerCase().startsWith("it");
    const banner = document.createElement("section");
    banner.id = "phoenix-consent";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", italian ? "Preferenze privacy" : "Privacy preferences");
    banner.innerHTML = `<div class="phoenix-consent-copy"><strong>${italian ? "Analytics dettagliate" : "Detailed analytics"}</strong><p>${italian ? "Con il tuo consenso Phoenix registra IP, browser, sistema operativo, dispositivo e pagine visitate senza una scadenza automatica. Puoi revocare e cancellare i dati dal pulsante Privacy. Nessun dato viene venduto o usato per pubblicità." : "With your consent Phoenix stores IP, browser, operating system, device and visited pages without automatic expiry. You can withdraw and erase the data through the Privacy button. Data is not sold or used for advertising."}</p><a href="/privacy.html">${italian ? "Leggi l’informativa" : "Read the privacy policy"}</a></div><div class="phoenix-consent-actions"><button type="button" data-consent="no">${italian ? "Solo necessari" : "Necessary only"}</button><button type="button" class="accept" data-consent="yes">${italian ? "Accetta analisi" : "Accept analytics"}</button></div>`;
    banner.addEventListener("click", (click) => {
      const choice = click.target.closest("[data-consent]")?.dataset.consent;
      if (choice) setConsent(choice === "yes");
    });
    document.body.appendChild(banner);
  }

  function addPrivacyControls() {
    if (isAdmin) return;
    const style = document.createElement("style");
    style.textContent = `#phoenix-consent{position:fixed;z-index:2147483000;left:16px;right:16px;bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:22px;max-width:920px;margin:auto;padding:18px 20px;border:1px solid #8f2639;border-radius:14px;background:rgba(10,5,7,.98);box-shadow:0 18px 70px #000;color:#f8f2f4;font:14px/1.5 Inter,system-ui,sans-serif}#phoenix-consent strong{display:block;color:#fff;font-size:16px}#phoenix-consent p{margin:4px 0;color:#cbbbc0}#phoenix-consent a{color:#ff7d90}#phoenix-consent .phoenix-consent-actions{display:flex;gap:9px;flex-shrink:0}#phoenix-consent button,#phoenix-privacy-settings{border:1px solid #713041;border-radius:8px;background:#160b0e;color:#fff;padding:10px 13px;font-weight:750;cursor:pointer}#phoenix-consent button.accept{background:linear-gradient(#d8324c,#8f152a);border-color:#ec5268}#phoenix-privacy-settings{position:fixed;z-index:2147482000;left:10px;bottom:10px;padding:7px 9px;font-size:11px;opacity:.72}#phoenix-privacy-settings:hover{opacity:1}@media(max-width:680px){#phoenix-consent{display:block}#phoenix-consent .phoenix-consent-actions{margin-top:14px}#phoenix-consent button{flex:1}}`;
    document.head.appendChild(style);
    const settings = document.createElement("button");
    settings.id = "phoenix-privacy-settings";
    settings.type = "button";
    settings.textContent = "Privacy";
    settings.addEventListener("click", showConsent);
    document.body.appendChild(settings);
    if (!storedConsent()) showConsent();
  }

  const analytics = { event, hasDetailedConsent, consentVersion };
  Object.defineProperty(analytics, "visitorId", { get: () => ensureVisitorId() });
  window.phoenixAnalytics = analytics;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addPrivacyControls, { once: true });
  else addPrivacyControls();
  if (!isAdmin) sendPageView();

  document.addEventListener("click", (click) => {
    const link = click.target.closest("a[href]");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href) && !href.startsWith(location.origin)) {
      event("outbound_click", { host: new URL(href).hostname });
    }
  });
})();
