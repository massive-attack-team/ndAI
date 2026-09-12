const fields = ["user", "role", "enabled", "failClosed"];

chrome.storage.local.get(fields).then((cfg) => {
  document.getElementById("user").value = cfg.user || "";
  document.getElementById("role").value = cfg.role || "default";
  document.getElementById("enabled").checked = cfg.enabled !== false;
  document.getElementById("failClosed").checked = cfg.failClosed !== false;
});

fields.forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener("change", () => {
    const value = el.type === "checkbox" ? el.checked : el.value;
    chrome.storage.local.set({ [id]: value });
  });
});

chrome.runtime.sendMessage({ type: "health" }, (health) => {
  const status = document.getElementById("status");
  const note = document.getElementById("note");
  if (!health) {
    status.innerHTML = '<span class="dot down"></span>Local service not reachable';
    note.textContent = "Start it with: python -m detector.main";
    return;
  }
  if (!health.semantic) {
    status.innerHTML = '<span class="dot warn"></span>Running on the fallback model';
    note.textContent = "Paraphrase detection is off. Install sentence-transformers and restart.";
    return;
  }
  status.innerHTML = '<span class="dot up"></span>Checking on this machine';
  note.textContent = health.rewrite_model_up
    ? "Rewrites are generated locally."
    : "Rewrite model is down, so sensitive text will be blocked rather than rewritten.";
});
