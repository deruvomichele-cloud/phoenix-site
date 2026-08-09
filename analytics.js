(() => {
  const key = "phoenixVisitorId";
  let visitorId;
  try {
    visitorId = localStorage.getItem(key);
    if (!visitorId) {
      visitorId = crypto.randomUUID();
      localStorage.setItem(key, visitorId);
    }
  } catch {
    visitorId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function campaignSource() {
    const params = new URLSearchParams(location.search);
    return params.get("utm_source") || "";
  }

  function event(name, metadata = {}) {
    const payload = JSON.stringify({
      event: name,
      visitorId,
      path: location.pathname,
      referrer: document.referrer,
      source: campaignSource(),
      metadata: {
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: `${screen.width}x${screen.height}`,
        ...metadata,
      },
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/events", new Blob([payload], { type: "application/json" }));
      return;
    }
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  }

  window.phoenixAnalytics = { event, visitorId };
  event("page_view", { title: document.title });

  document.addEventListener("click", (click) => {
    const link = click.target.closest("a[href]");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href) && !href.startsWith(location.origin)) {
      event("outbound_click", { host: new URL(href).hostname });
    }
  });
})();
