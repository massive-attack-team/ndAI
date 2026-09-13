// The only component that calls the local service, and the router between
// chat tabs and review pages.

import { fromBase64, toBase64 } from "./review/bytes";
import type { WireFile } from "./review/channel";
import { createSession } from "./review/session";
import { deleteSession, getSession } from "./review/store";

const ENDPOINT = "http://127.0.0.1:8000";
const DEFAULTS = { user: "unknown", role: "default", failClosed: true, enabled: true };

type Reply = (response?: unknown) => void;

async function settings(): Promise<typeof DEFAULTS> {
  const keys = Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>;
  return { ...DEFAULTS, ...(await chrome.storage.local.get(keys)) } as typeof DEFAULTS;
}

async function inspect(text: string, destination: string) {
  const cfg = await settings();
  if (!cfg.enabled) return { action: "allow", rule: "extension disabled", message: "", findings: [] };
  try {
    const res = await fetch(`${ENDPOINT}/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, destination, user: cfg.user, role: cfg.role }),
    });
    if (!res.ok) throw new Error(`detector returned ${res.status}`);
    return await res.json();
  } catch {
    // Fail closed by default. A security control that silently stops working is
    // worse than one that gets in the way, but this trade-off is the reason
    // people uninstall tools like this, so it is a setting and not a constant.
    return {
      action: cfg.failClosed ? "block" : "allow",
      rule: "detector unavailable",
      message: cfg.failClosed
        ? "NDAi is not running, so this text has not been checked. Start the local service, or switch to fail-open in the extension settings."
        : "NDAi is not running. This text was not checked.",
      findings: [],
      degraded: true,
    };
  }
}

const respond = (reply: Reply, work: Promise<unknown>) =>
  work.then(
    (value) => reply({ ok: true, value }),
    (err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );

async function finish(id: string): Promise<void> {
  const session = await getSession(id);
  if (!session?.result) throw new Error("This review has expired.");
  if (session.tabId == null) throw new Error("The chat tab for this upload is unknown.");
  const files = await Promise.all(session.result.map(async (f) => ({ name: f.name, type: f.type, data: toBase64(await f.arrayBuffer()) })));
  try {
    await chrome.tabs.sendMessage(session.tabId, { type: "review:finished", id, files });
  } catch {
    // Session is kept so the review page can still offer the download.
    throw new Error(`The ${session.host} tab was closed or reloaded, so the upload can't resume there. Download the file instead.`);
  }
  await deleteSession(id);
  const tab = await chrome.tabs.update(session.tabId, { active: true });
  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}

async function cancel(id: string): Promise<void> {
  const session = await getSession(id);
  await deleteSession(id);
  const event = { type: "review:cancelled", id };
  // Whichever side didn't initiate needs to hear about it; both sides ignore repeats.
  await chrome.runtime.sendMessage(event).catch(() => undefined);
  if (session?.tabId != null) await chrome.tabs.sendMessage(session.tabId, event).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((msg, sender, reply: Reply) => {
  switch (msg?.type) {
    case "inspect": {
      const destination = msg.destination ?? new URL(sender.tab?.url || msg.href || "https://unknown").hostname;
      void inspect(msg.text, destination).then(reply);
      return true;
    }
    case "health":
      fetch(`${ENDPOINT}/health`).then((r) => r.json()).then(reply).catch(() => reply(null));
      return true;
    case "review:create": {
      // Mock sanitizer (src/review/mock_sanitizer.ts); TODO(backend): POST /documents/sanitize.
      const files = (msg.files as WireFile[]).map((f) => ({ name: f.name, type: f.type, bytes: fromBase64(f.data) }));
      void respond(reply, createSession(files, msg.host, sender.tab?.id ?? null));
      return true;
    }
    case "review:open":
      void respond(reply, chrome.tabs.create({
        url: chrome.runtime.getURL(`review.html#${msg.id}`),
        openerTabId: sender.tab?.id,
        index: sender.tab ? sender.tab.index + 1 : undefined,
      }));
      return true;
    case "review:cancel":
      void respond(reply, cancel(msg.id));
      return true;
    case "review:finish":
      void respond(reply, finish(msg.id));
      return true;
  }
  return undefined;
});
