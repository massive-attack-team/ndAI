// The only component allowed to make a network call, and it only ever calls
// 127.0.0.1. Content scripts never hold the endpoint.

const ENDPOINT = "http://127.0.0.1:8000";
const DEFAULTS = { user: "unknown", role: "default", failClosed: true, enabled: true };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

async function inspect(text, destination) {
  const cfg = await settings();
  if (!cfg.enabled) {
    return { action: "allow", rule: "extension disabled", message: "", findings: [] };
  }
  try {
    const res = await fetch(`${ENDPOINT}/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, destination, user: cfg.user, role: cfg.role }),
    });
    if (!res.ok) throw new Error(`detector returned ${res.status}`);
    return await res.json();
  } catch (err) {
    // Fail closed by default. A security control that silently stops working is
    // worse than one that gets in the way, but this trade-off is the reason
    // people uninstall tools like this, so it is a setting and not a constant.
    return {
      action: cfg.failClosed ? "block" : "allow",
      rule: "detector unavailable",
      message: cfg.failClosed
        ? "ndAI is not running, so this text has not been checked. Start the local service, or switch to fail-open in the extension settings."
        : "ndAI is not running. This text was not checked.",
      findings: [],
      degraded: true,
    };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "inspect") {
    const destination = new URL(sender.tab?.url || msg.href || "https://unknown").hostname;
    inspect(msg.text, destination).then(sendResponse);
    return true; // async
  }
  if (msg.type === "health") {
    fetch(`${ENDPOINT}/health`)
      .then((r) => r.json())
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }
});
