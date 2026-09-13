// Review page: shows every proposed change in a held upload and requires an
// explicit decision on each before the file can go out.
//
// Components (plain functions over the DOM, no framework):
//   header · intro (file + progress) · document tabs
//   DocumentView  — extracted text with change marks; "Markup" vs "Result preview"
//   ChangeList    — filter chips + ChangeCard (diff, evidence, decision)
//   Footer        — readiness + Cancel / Upload
//   StatusScreen  — loading, submitting, done, cancelled, missing, error
//
// Document extraction and the sanitized output are mocked
// (./mock_sanitizer.ts) until the backend endpoints exist.

import { hasRuntime } from "../detector_client";
import { fill, h, type Child } from "../dom";
import { keepWidest } from "../edits";
import { TIER_WORD } from "../tiers";
import { cancelReview, finishReview, onReviewEvent } from "./channel";
import { buildOutput } from "./mock_sanitizer";
import { getSession, putSession } from "./store";
import type { Change, Decision, ReviewDocument, ReviewSession } from "./types";
import "./review.css";

type Phase = "loading" | "review" | "submitting" | "done" | "cancelled" | "missing" | "error";
type Filter = "all" | Decision;
type View = "markup" | "result";

const app = document.getElementById("app")!;
const sessionId = decodeURIComponent(location.hash.slice(1));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

let session: ReviewSession | null = null;
let phase: Phase = "loading";
let docIndex = 0;
let selected: string | null = null;
let filter: Filter = "all";
let view: View = "markup";
let outputs: File[] = [];
let errorMessage = "";
let cancelledFromChat = false;

interface Refs {
  docPanel: HTMLElement;
  docBody: HTMLElement;
  viewButtons: HTMLButtonElement[];
  progressTrack: HTMLElement;
  progressFill: HTMLElement;
  progressText: HTMLElement;
  filters: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  cards: Map<string, HTMLElement>;
  footerStatus: HTMLElement;
  submit: HTMLButtonElement;
}
let refs: Refs | null = null;

const doc = (): ReviewDocument => session!.documents[docIndex];
const allChanges = () => session!.documents.flatMap((d) => d.changes);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function tally(changes: Change[]) {
  const t = { all: changes.length, pending: 0, approved: 0, rejected: 0 };
  for (const c of changes) t[c.decision]++;
  return t;
}

// ---- small components ----------------------------------------------------------

function button(label: Child, kind: "primary" | "secondary" | "quiet", onClick: () => void): HTMLButtonElement {
  const b = h("button", { type: "button", class: `rv-btn rv-btn-${kind}` }, label);
  b.addEventListener("click", onClick);
  return b;
}

function downloadButton(file: File): HTMLAnchorElement {
  return h("a", { class: "rv-btn rv-btn-secondary", href: URL.createObjectURL(file), download: file.name }, `Download ${file.name}`);
}

function closeTab(): void {
  if (hasRuntime()) chrome.tabs.getCurrent((tab) => (tab?.id != null ? void chrome.tabs.remove(tab.id) : window.close()));
  else window.close();
}

function header(): HTMLElement {
  return h("header", { class: "rv-header" },
    h("div", { class: "rv-brand" },
      h("span", { class: "rv-logo", "aria-hidden": "true" }, "N"),
      h("span", { class: "rv-brand-name" }, "ndAI"),
      h("span", { class: "rv-brand-sep", "aria-hidden": "true" }, "/"),
      h("span", {}, "Upload review")),
    session && phase === "review" && h("p", { class: "rv-hold" },
      h("span", { class: "rv-hold-dot", "aria-hidden": "true" }), `Upload to ${session.host} is on hold`));
}

function statusScreen(opts: { tone: "success" | "neutral" | "danger" | "loading"; title: string; text: string; body?: Child[]; actions?: Child[] }): HTMLElement {
  return h("main", { class: "rv-status" },
    h("div", { class: "rv-status-card", "data-tone": opts.tone },
      h("div", { class: "rv-status-icon", "aria-hidden": "true" }),
      h("h1", { class: "rv-status-title" }, opts.title),
      h("p", { class: "rv-status-text", id: "rv-status-text" }, opts.text),
      ...(opts.body ?? []),
      opts.actions?.length ? h("div", { class: "rv-status-actions" }, ...opts.actions) : null));
}

function outputList(files: File[]): HTMLElement {
  return h("ul", { class: "rv-outputs" }, ...files.map((f, i) => {
    const t = tally(session!.documents[i]?.changes ?? []);
    return h("li", {},
      h("span", { class: "rv-output-name" }, f.name),
      h("span", { class: "rv-output-meta" }, `${formatBytes(f.size)} · ${t.approved} applied, ${t.rejected} kept`));
  }));
}

function placeholderNote(): HTMLElement | null {
  if (!session?.documents.some((d) => d.placeholder)) return null;
  return h("p", { class: "rv-placeholder", role: "note" },
    h("strong", {}, "Mock output. "),
    "The backend will return the sanitized PDF; this build hands back a labelled placeholder text file instead.");
}

// ---- top-level render ----------------------------------------------------------

function render(): void {
  refs = null;
  const host = session?.host ?? "the AI tool";
  switch (phase) {
    case "loading":
      return fill(app, header(), statusScreen({ tone: "loading", title: "Loading review", text: "Opening the document…" }));
    case "missing":
      return fill(app, header(), statusScreen({
        tone: "neutral", title: "This review isn't available",
        text: "It was already completed or cancelled, or it expired after an hour. Files are deleted from the extension when a review ends.",
        actions: [button("Close tab", "secondary", closeTab)],
      }));
    case "cancelled":
      return fill(app, header(), statusScreen({
        tone: "neutral", title: "Upload cancelled",
        text: `${cancelledFromChat ? "Cancelled from the chat tab. " : ""}Nothing was uploaded to ${host}.`,
        actions: [button("Close tab", "secondary", closeTab)],
      }));
    case "submitting":
      return fill(app, header(), statusScreen({ tone: "loading", title: "Preparing files", text: "Applying approved changes…" }));
    case "done":
      return fill(app, header(), statusScreen({
        tone: "success", title: "Sanitized copy sent",
        text: `Your approved changes were applied and the upload to ${host} has resumed in the chat tab.`,
        body: [outputList(outputs), placeholderNote()],
        actions: [...outputs.map(downloadButton), button("Close tab", "primary", closeTab)],
      }));
    case "error":
      return fill(app, header(), statusScreen({
        tone: "danger", title: "The upload couldn't resume", text: errorMessage,
        body: outputs.length ? [outputList(outputs)] : [],
        actions: [...outputs.map(downloadButton), button("Back to review", "secondary", () => { phase = "review"; render(); })],
      }));
    case "review":
      return renderReview();
  }
}

function setStatusText(text: string): void {
  const el = document.getElementById("rv-status-text");
  if (el) el.textContent = text;
}

// ---- review layout ----------------------------------------------------------------

function renderReview(): void {
  const s = session!;
  const d = doc();

  const progressFill = h("div", { class: "rv-progress-fill" });
  const progressTrack = h("div", { class: "rv-progress-track", role: "progressbar", "aria-label": "Changes reviewed", "aria-valuemin": "0" }, progressFill);
  const progressText = h("span", { class: "rv-progress-text" });
  const filters = h("div", { class: "rv-filters", role: "toolbar", "aria-label": "Filter changes" });
  const empty = h("p", { class: "rv-empty", hidden: "" }, "No changes match this filter.");
  const list = h("div", { class: "rv-list" });
  const docBody = h("div", { class: "rv-doc-body" });
  const footerStatus = h("p", { class: "rv-footer-status", "aria-live": "polite" });
  const submit = button("Upload sanitized file", "primary", () => void submitReview());
  const pages = d.kind === "pdf" ? plural(d.pageCount, "page") : "Text file";

  const viewButtons = (["markup", "result"] as const).map((v) => {
    const b = h("button", { type: "button", class: "rv-seg", "aria-pressed": String(view === v) }, v === "markup" ? "Markup" : "Result preview");
    b.addEventListener("click", () => setView(v));
    return b;
  });
  const docPanel = h("section", { class: "rv-doc", "aria-label": "Document preview", "data-view": view },
    h("div", { class: "rv-panel-head" },
      h("h2", { class: "rv-panel-title" }, pages),
      h("div", { class: "rv-segmented", role: "group", "aria-label": "Document view" }, ...viewButtons)),
    docBody);

  refs = { docPanel, docBody, viewButtons, progressTrack, progressFill, progressText, filters, list, empty, cards: new Map(), footerStatus, submit };

  const kind = d.kind === "pdf" ? "PDF" : (d.name.split(".").pop() ?? "TXT").slice(0, 4).toUpperCase();
  const intro = h("section", { class: "rv-intro" },
    h("div", { class: "rv-file" },
      h("div", { class: "rv-file-icon", "aria-hidden": "true" }, kind),
      h("div", { class: "rv-file-text" },
        h("p", { class: "rv-eyebrow" }, "Approve each change before upload"),
        h("h1", { class: "rv-file-name" }, s.documents.length > 1 ? `${s.documents.length} documents` : d.name),
        h("div", { class: "rv-file-meta" },
          h("span", { class: "rv-meta" }, pages),
          h("span", { class: "rv-meta" }, formatBytes(d.size)),
          h("span", { class: "rv-meta" }, `To ${s.host}`),
          h("span", { class: "rv-chip", "data-tier": d.verdict.tier }, TIER_WORD[d.verdict.tier])))),
    h("div", { class: "rv-progress" },
      h("div", { class: "rv-progress-row" }, h("span", {}, "Reviewed"), progressText),
      progressTrack,
      h("p", { class: "rv-verdict" }, d.verdict.message)));

  const tabs = s.documents.length > 1 && h("nav", { class: "rv-tabs", "aria-label": "Documents" }, ...s.documents.map((x, i) => {
    const t = tally(x.changes);
    const tab = h("button", { type: "button", class: "rv-tab", "aria-current": String(i === docIndex) },
      x.name, h("span", { class: "rv-tab-count" }, `${t.all - t.pending}/${t.all}`));
    tab.addEventListener("click", () => { docIndex = i; selected = null; render(); selectFirstPending(); });
    return tab;
  }));

  const aside = h("aside", { class: "rv-changes", "aria-label": "Proposed changes" },
    h("div", { class: "rv-panel-head rv-changes-head" },
      h("h2", { class: "rv-panel-title" }, "Changes"),
      h("p", { class: "rv-shortcuts" }, h("kbd", {}, "J"), h("kbd", {}, "K"), " move · ", h("kbd", {}, "A"), " approve · ", h("kbd", {}, "R"), " keep")),
    filters,
    list);

  const footer = h("footer", { class: "rv-footer" },
    footerStatus,
    h("div", { class: "rv-footer-actions" }, button("Cancel upload", "quiet", () => void cancel()), submit));

  fill(app, header(), h("div", { class: "rv-shell" }, intro, tabs, h("div", { class: "rv-main" }, docPanel, aside)), footer);

  fill(list, ...d.changes.map(changeCard), empty);
  renderFilters();
  renderProgress();
  renderFooter();
  renderText();
}

function setView(v: View): void {
  view = v;
  if (!refs) return;
  refs.docPanel.dataset.view = v;
  refs.viewButtons.forEach((b, i) => b.setAttribute("aria-pressed", String((i === 0 ? "markup" : "result") === v)));
  renderText();
}

// ---- change list -----------------------------------------------------------------------

function changeCard(c: Change): HTMLElement {
  const titleId = `${c.id}-title`;

  let before: HTMLElement;
  let reveal: HTMLButtonElement | null = null;
  if (c.masked) {
    const masked = c.masked;
    before = h("del", { class: "rv-secret" }, masked);
    reveal = h("button", { type: "button", class: "rv-reveal", "aria-pressed": "false" }, "Show value");
    reveal.addEventListener("click", (e) => {
      e.stopPropagation();
      const shown = reveal!.getAttribute("aria-pressed") === "true";
      before.textContent = shown ? masked : c.before;
      reveal!.setAttribute("aria-pressed", String(!shown));
      reveal!.textContent = shown ? "Show value" : "Hide value";
    });
  } else {
    before = h("del", {}, c.before);
  }

  const choice = (decision: Decision, label: Child[]) => {
    const b = h("button", { type: "button", class: "rv-choice", "data-choice": decision, "aria-pressed": "false" }, ...label);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      select(c.id);
      decide(c, c.decision === decision ? "pending" : decision); // pressing again undoes
    });
    return b;
  };

  const card = h("article", {
    class: "rv-card", tabindex: "-1", "data-change": c.id, "data-tier": c.tier, "aria-labelledby": titleId,
  },
    h("div", { class: "rv-card-head" },
      h("span", { class: "rv-card-num" }, String(c.index)),
      h("h3", { class: "rv-card-title", id: titleId }, c.title),
      h("span", { class: "rv-chip", "data-tier": c.tier }, TIER_WORD[c.tier])),
    h("p", { class: "rv-card-meta" }, [c.page ? `Page ${c.page}` : null, c.evidence].filter(Boolean).join(" · ") || "Text file"),
    h("p", { class: "rv-card-reason" }, c.reason),
    h("div", { class: "rv-diff" },
      h("div", { class: "rv-diff-row", "data-side": "before" },
        h("span", { class: "rv-diff-label" }, "Original"),
        h("p", { class: "rv-diff-text" }, c.contextBefore, before, c.contextAfter),
        reveal),
      h("div", { class: "rv-diff-row", "data-side": "after" },
        h("span", { class: "rv-diff-label" }, "Sanitized"),
        h("p", { class: "rv-diff-text" }, c.contextBefore, h("ins", {}, c.after), c.contextAfter))),
    h("div", { class: "rv-decide", role: "group", "aria-label": `Decision for change ${c.index}` },
      choice("approved", [h("span", { class: "rv-choice-icon", "aria-hidden": "true" }, "✓"), "Approve change"]),
      choice("rejected", ["Keep original"])),
    h("p", { class: "rv-card-note" }));

  card.addEventListener("click", () => select(c.id, { scrollDoc: true }));
  refs!.cards.set(c.id, card);
  updateCard(c);
  return card;
}

function updateCard(c: Change): void {
  const card = refs?.cards.get(c.id);
  if (!card) return;
  card.dataset.decision = c.decision;
  card.classList.toggle("is-selected", c.id === selected);
  for (const b of card.querySelectorAll<HTMLButtonElement>(".rv-choice")) {
    b.setAttribute("aria-pressed", String(b.dataset.choice === c.decision));
  }
  const note = card.querySelector<HTMLElement>(".rv-card-note")!;
  const blocked = c.decision === "rejected" && c.tier === "red";
  note.dataset.tone = blocked ? "danger" : "";
  note.textContent =
    c.decision === "approved" ? `Approved: replaced with ${c.after}.`
    : blocked ? "Kept. Blocked content can't be uploaded, so this file will stay on hold."
    : c.decision === "rejected" ? "Kept: this passage uploads unchanged."
    : "";
}

function renderFilters(): void {
  if (!refs) return;
  const t = tally(doc().changes);
  const items: Array<[Filter, string]> = [["all", "All"], ["pending", "Pending"], ["approved", "Approved"], ["rejected", "Kept"]];
  fill(refs.filters, ...items.map(([f, label]) => {
    const b = h("button", { type: "button", class: "rv-filter", "aria-pressed": String(filter === f) },
      label, h("span", { class: "rv-filter-count" }, String(t[f])));
    b.addEventListener("click", () => { filter = f; renderFilters(); applyFilter(); });
    return b;
  }));
}

function applyFilter(): void {
  if (!refs) return;
  let shown = 0;
  for (const c of doc().changes) {
    const visible = filter === "all" || c.decision === filter;
    refs.cards.get(c.id)!.hidden = !visible;
    if (visible) shown++;
  }
  refs.empty.hidden = shown > 0;
}

function renderProgress(): void {
  if (!refs) return;
  const t = tally(allChanges());
  const done = t.all - t.pending;
  refs.progressText.textContent = `${done} of ${t.all}`;
  refs.progressFill.style.width = `${t.all ? (done / t.all) * 100 : 100}%`;
  refs.progressTrack.setAttribute("aria-valuemax", String(t.all));
  refs.progressTrack.setAttribute("aria-valuenow", String(done));
}

function renderFooter(): void {
  if (!refs) return;
  const t = tally(allChanges());
  const blocked = allChanges().filter((c) => c.tier === "red" && c.decision === "rejected").length;
  let tone = "info";
  let text: string;
  if (blocked) {
    tone = "danger";
    text = `${plural(blocked, "blocked item")} kept. Approve ${blocked === 1 ? "it" : "them"} or cancel the upload.`;
  } else if (t.pending) {
    text = `${plural(t.pending, "change")} still need${t.pending === 1 ? "s" : ""} a decision.`;
  } else {
    tone = "ready";
    text = `Ready to upload: ${t.approved} approved, ${t.rejected} kept.`;
  }
  fill(refs.footerStatus, h("span", { class: "rv-dot", "data-tone": tone, "aria-hidden": "true" }), text);
  refs.submit.disabled = blocked > 0 || t.pending > 0;
  refs.submit.textContent = session!.documents.length > 1 ? "Upload sanitized files" : "Upload sanitized file";
}

// ---- selection + decisions -----------------------------------------------------------------

let persistTimer = 0;
function persist(): void {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => { if (session && phase === "review") void putSession(session); }, 250);
}

function scrollBehavior(): ScrollBehavior {
  return reducedMotion.matches ? "auto" : "smooth";
}

function select(id: string | null, opts: { scrollList?: boolean; scrollDoc?: boolean } = {}): void {
  const previous = selected;
  selected = id;
  for (const cid of [previous, id]) {
    const c = doc().changes.find((x) => x.id === cid);
    if (c) updateCard(c);
  }
  syncDocument();
  if (!id) return;
  if (opts.scrollList) refs?.cards.get(id)?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  if (opts.scrollDoc) revealInDocument(id);
}

function selectFirstPending(): void {
  const first = doc().changes.find((c) => c.decision === "pending") ?? doc().changes[0];
  if (first) select(first.id);
}

function decide(c: Change, decision: Decision): void {
  c.decision = decision;
  persist();
  updateCard(c);
  if (view === "result") renderText();
  syncDocument();
  renderFilters();
  applyFilter();
  renderProgress();
  renderFooter();
  if (decision === "pending") return;
  const list = doc().changes;
  const i = list.indexOf(c);
  const next = [...list.slice(i + 1), ...list.slice(0, i)].find((x) => x.decision === "pending");
  if (next) select(next.id, { scrollList: true, scrollDoc: true });
}

async function cancel(): Promise<void> {
  if (!session) return;
  phase = "cancelled";
  render();
  await cancelReview(session.id);
}

async function submitReview(): Promise<void> {
  const s = session!;
  phase = "submitting";
  outputs = [];
  render();
  try {
    for (const [i, d] of s.documents.entries()) {
      setStatusText(`Applying changes to ${d.name}${s.documents.length > 1 ? ` (${i + 1} of ${s.documents.length})` : ""}…`);
      outputs.push(await buildOutput(d));
    }
    setStatusText(`Handing the file back to ${s.host}…`);
    await finishReview(s, outputs);
    phase = "done";
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    phase = "error";
  }
  render();
}

// ---- document view --------------------------------------------------------------------------

function renderText(): void {
  if (!refs) return;
  const d = doc();
  const t = d.text;
  const replaced = view === "result"
    ? keepWidest(d.changes.filter((c) => c.decision === "approved").map((c) => ({ start: c.start, end: c.end, replacement: c.after, id: c.id })))
    : [];
  const points = [...new Set([0, t.length, ...d.changes.flatMap((c) => [c.start, c.end])])].sort((a, b) => a - b);

  const nodes: Child[] = [];
  let page = 1;
  // Page breaks ("\f") from extracted PDF text become labelled dividers.
  const pushText = (s: string) => s.split("\f").forEach((part, i) => {
    if (i > 0) nodes.push(h("span", { class: "rv-pagebreak", "data-page": `Page ${++page}` }));
    if (part) nodes.push(part);
  });
  if (d.kind === "pdf") nodes.push(h("span", { class: "rv-pagebreak rv-pagebreak-first", "data-page": "Page 1" }));

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const rep = replaced.find((e) => a >= e.start && b <= e.end);
    if (rep) {
      if (a === rep.start) {
        const ins = h("ins", { class: "rv-redacted", "data-change": rep.id }, rep.replacement);
        ins.addEventListener("click", () => select(rep.id, { scrollList: true }));
        nodes.push(ins);
      }
      continue;
    }
    const covering = d.changes.filter((c) => c.start <= a && c.end >= b);
    if (!covering.length) { pushText(t.slice(a, b)); continue; }
    const narrowest = covering.reduce((x, y) => (y.end - y.start < x.end - x.start ? y : x));
    const mark = h("mark", { class: "rv-mark", "data-change": narrowest.id, "data-changes": covering.map((c) => c.id).join(" ") }, t.slice(a, b));
    mark.addEventListener("click", () => select(narrowest.id, { scrollList: true }));
    nodes.push(mark);
  }

  fill(refs.docBody,
    d.placeholder && h("p", { class: "rv-placeholder", role: "note" },
      h("strong", {}, "Placeholder preview. "),
      "PDF text extraction and page rendering are backend work that isn't connected yet, so this shows mock extracted text, not the uploaded file."),
    h("div", { class: "rv-textdoc", "data-kind": d.kind }, h("pre", { class: "rv-textdoc-body" }, ...nodes)));
  syncDocument();
}

function syncDocument(): void {
  if (!refs) return;
  const byId = new Map(doc().changes.map((c) => [c.id, c]));
  for (const el of refs.docBody.querySelectorAll<HTMLElement>("[data-change]")) {
    const own = byId.get(el.dataset.change!);
    if (!own) continue;
    const ids = (el.dataset.changes ?? own.id).split(" ");
    el.dataset.decision = own.decision;
    el.dataset.tier = own.tier;
    el.classList.toggle("is-selected", selected !== null && ids.includes(selected));
  }
}

function revealInDocument(id: string): void {
  if (!refs) return;
  const esc = CSS.escape(id);
  refs.docBody.querySelector<HTMLElement>(`[data-change="${esc}"], [data-changes~="${esc}"]`)
    ?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
}

// ---- keyboard -------------------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (phase !== "review" || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
  const key = e.key.toLowerCase();
  const visible = doc().changes.filter((c) => filter === "all" || c.decision === filter);

  if (key === "j" || key === "k") {
    if (!visible.length) return;
    e.preventDefault();
    const at = visible.findIndex((c) => c.id === selected);
    const next = at < 0 ? visible[0] : visible[Math.min(visible.length - 1, Math.max(0, at + (key === "j" ? 1 : -1)))];
    select(next.id, { scrollList: true, scrollDoc: true });
    refs?.cards.get(next.id)?.focus({ preventScroll: true });
    return;
  }
  const current = doc().changes.find((c) => c.id === selected);
  if (!current) return;
  if (key === "a") { e.preventDefault(); decide(current, "approved"); }
  else if (key === "r") { e.preventDefault(); decide(current, "rejected"); }
  else if (key === "u") { e.preventDefault(); decide(current, "pending"); }
});

// ---- boot -------------------------------------------------------------------------------------------

onReviewEvent((e) => {
  if (!session || e.id !== session.id || e.type !== "review:cancelled") return;
  if (phase === "review" || phase === "loading") {
    cancelledFromChat = true;
    phase = "cancelled";
    render();
  }
});

async function init(): Promise<void> {
  render();
  try {
    session = sessionId ? ((await getSession(sessionId)) ?? null) : null;
  } catch {
    session = null;
  }
  if (!session || session.status !== "ready" || !session.documents.length) {
    phase = "missing";
    return render();
  }
  phase = "review";
  document.title = `Review ${session.documents.length > 1 ? `${session.documents.length} documents` : session.documents[0].name} · ndAI`;
  render();
  selectFirstPending();
}

void init();
