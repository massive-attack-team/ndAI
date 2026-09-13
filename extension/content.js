// Intercepts the two moments text leaves the employee's control: pasting into
// the composer, and sending it.
//
// Interception is deliberately shallow. Hooking fetch or XHR would catch more,
// but it also breaks the host page every time it ships a change, and a security
// tool that breaks ChatGPT gets uninstalled the same week.

(() => {
  const MIN_LENGTH = 40; // below this, the check is noise
  let panel = null;

  const composer = () =>
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector("textarea");

  function insertText(target, text) {
    target.focus();
    if (!document.execCommand("insertText", false, text)) {
      if ("value" in target) {
        const start = target.selectionStart ?? target.value.length;
        target.value = target.value.slice(0, start) + text + target.value.slice(start);
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  function readComposer() {
    const el = composer();
    if (!el) return "";
    return ("value" in el ? el.value : el.innerText) || "";
  }

  function ask(text) {
    return new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "inspect", text, href: location.href }, resolve)
    );
  }

  function closePanel() {
    panel?.remove();
    panel = null;
  }

  // Returns the text to insert, or null if the user cancelled.
  function showPanel(result, original) {
    closePanel();
    return new Promise((resolve) => {
      panel = document.createElement("div");
      panel.className = `ndai-panel ndai-${result.action}`;

      const findings = (result.findings || [])
        .map((f) => {
          if (f.kind === "provenance")
            return `<li><span class="ndai-score">${Math.round(f.score * 100)}%</span> match to <code>${f.label}</code>${f.verbatim ? " (near verbatim)" : ""}</li>`;
          if (f.kind === "context")
            return `<li><span class="ndai-flag">Pieced together</span> ${f.chunks_out} of ${f.chunk_total} sections of <code>${f.label}</code> across ${f.prompts} prompts${f.scope === "team" ? " from your team" : ""}</li>`;
          if (f.kind === "secret")
            return `<li><span class="ndai-flag">Credential</span> ${f.label} <code>${f.preview}</code></li>`;
          return `<li>Reads as ${String(f.label).replace(/_/g, " ")}</li>`;
        })
        .join("");

      const rewritten = result.rewritten
        ? `<label class="ndai-label">Safe version</label><div class="ndai-rewrite">${escapeHtml(result.rewritten)}</div>`
        : "";

      const actions = [];
      if (result.rewritten) actions.push(`<button data-act="safe" class="ndai-primary">Send safe version</button>`);
      if (result.action !== "block") actions.push(`<button data-act="original">Send original anyway</button>`);
      actions.push(`<button data-act="local">Open in internal model</button>`);
      actions.push(`<button data-act="cancel" class="ndai-quiet">Cancel</button>`);

      panel.innerHTML = `
        <div class="ndai-head">
          <span class="ndai-verdict">${verdictText(result.action)}</span>
          <span class="ndai-meta">${result.latency_ms ?? "?"} ms, checked on this machine</span>
        </div>
        <p class="ndai-message">${escapeHtml(result.message || "")}</p>
        ${findings ? `<ul class="ndai-findings">${findings}</ul>` : ""}
        ${rewritten}
        <div class="ndai-actions">${actions.join("")}</div>`;

      document.body.appendChild(panel);
      panel.querySelector("button")?.focus();

      panel.addEventListener("click", (e) => {
        const act = e.target.dataset?.act;
        if (!act) return;
        closePanel();
        if (act === "safe") resolve(result.rewritten);
        else if (act === "original") resolve(original);
        else if (act === "local") {
          window.open("http://127.0.0.1:8000/health", "_blank"); // stand-in for the internal model
          resolve(null);
        } else resolve(null);
      });
      panel.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { closePanel(); resolve(null); }
      });
    });
  }

  function verdictText(action) {
    return {
      allow: "Nothing sensitive found",
      warn: "Sensitive, and logged",
      sanitize: "Internal material found",
      block: "Blocked",
    }[action] || action;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function toast(message) {
    const el = document.createElement("div");
    el.className = "ndai-toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // --- paste ---------------------------------------------------------------
  document.addEventListener(
    "paste",
    async (event) => {
      const text = event.clipboardData?.getData("text/plain") || "";
      if (text.length < MIN_LENGTH) return;
      const target = event.target;
      event.preventDefault();
      event.stopPropagation();

      const result = await ask(text);
      if (result.action === "allow") return insertText(target, text);
      if (result.action === "warn") { insertText(target, text); return toast(result.message); }

      const chosen = await showPanel(result, text);
      if (chosen) insertText(target, chosen);
    },
    true
  );

  // --- send ----------------------------------------------------------------
  document.addEventListener(
    "keydown",
    async (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      if (event.__ndaiChecked) return;
      const text = readComposer();
      if (text.length < MIN_LENGTH) return;

      event.preventDefault();
      event.stopPropagation();

      const result = await ask(text);
      if (result.action === "allow" || result.action === "warn") {
        if (result.action === "warn") toast(result.message);
        return resend(event.target);
      }
      const chosen = await showPanel(result, text);
      if (!chosen) return;
      const el = composer();
      if ("value" in el) el.value = ""; else el.innerText = "";
      insertText(el, chosen);
      resend(el);
    },
    true
  );

  function resend(target) {
    const evt = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    evt.__ndaiChecked = true;
    target.dispatchEvent(evt);
  }

  chrome.runtime.sendMessage({ type: "health" }, (health) => {
    if (!health) toast("NDAi is not running. Start the local service before pasting internal material.");
    else if (!health.semantic) toast("NDAi is running on the fallback model. Paraphrase detection is off.");
  });
})();
