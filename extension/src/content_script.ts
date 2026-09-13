// ndAI inline inspector.
//
// Reads the composer, never writes to it. Everything visual lives in a fixed,
// pointer-transparent overlay inside our own shadow root, positioned from
// Range client rects. The only path that changes the prompt is an explicit
// user action, and that goes through the Selection API + execCommand so the
// host editor (ProseMirror, Slate, Lexical) receives an ordinary input
// transaction instead of a DOM it didn't produce.

import css from "./overlay_styles.css";
import { destination, hasRuntime, inspect } from "./detector_client";
import { fill, h, type Child } from "./dom";
import { cancelReview, createReview, onReviewEvent, openReview } from "./review/channel";
import type { ReviewSummary } from "./review/types";
import { showNotice } from "./upload_notice";
import {
  TIER_RANK, TIER_WORD, VERDICT, actionTier, describeFinding, findingKey, findingTier, maxTier, minTier,
} from "./tiers";
import { installUploadGuard, isDocument, reviewFile } from "./uploads";
import type { Finding, Inspection, Tier } from "./types";

const DEBOUNCE_MS = 450;     // typing pause before a check runs
const MIN_CHARS = 12;
const HOVER_OPEN_MS = 160;
const HOVER_CLOSE_MS = 240;
const EDGE = 8;              // min distance from the visual viewport edge
const GAP = 6;
const BADGE_SIZE = 22;

const SEND_BUTTONS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Send Message"]',
  "button.send-button",
].join(",");

const KNOWN_EDITORS = [
  "#prompt-textarea[contenteditable]",
  '.ProseMirror[contenteditable="true"]',
  '.ql-editor[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
].join(",");

// ---- text model -------------------------------------------------------------
//
// The detector returns character offsets. innerText can't be used to build the
// string those offsets refer to: its newline rules depend on layout and it
// gives no way back to DOM positions. So the string is built from the text
// nodes directly, recording where each node starts. Offsets then map back to
// (Text, offset) exactly, by binary search.

interface Segment { node: Text; start: number; end: number }
interface Snapshot { text: string; segments: Segment[] }

const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6",
  "TABLE", "TR", "TD", "TH", "SECTION", "ARTICLE", "HEADER", "FOOTER",
]);

function blockOf(node: Node, root: HTMLElement): Element {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
  }
  return root;
}

function snapshot(root: HTMLElement): Snapshot {
  const segments: Segment[] = [];
  let text = "";
  let lastBlock: Element | null = null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = n as HTMLElement;
      // Mentions, chips and other atom widgets aren't prompt text.
      if (el !== root && (el.contentEditable === "false" || el.getAttribute("aria-hidden") === "true")) {
        return NodeFilter.FILTER_REJECT;
      }
      return el.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const block = blockOf(n, root);
    if (lastBlock && block !== lastBlock && !text.endsWith("\n")) text += "\n";
    lastBlock = block;
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n as Text;
      if (!t.data) continue;
      segments.push({ node: t, start: text.length, end: text.length + t.data.length });
      text += t.data;
    } else {
      text += "\n";
    }
  }
  return { text, segments };
}

/** Offset in snapshot text -> DOM position. Offsets inside synthetic "\n" snap to the adjacent node. */
function locate(segs: Segment[], offset: number, edge: "start" | "end"): { node: Text; offset: number } | null {
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edge === "start" ? segs[mid].end <= offset : segs[mid].end < offset) lo = mid + 1;
    else hi = mid;
  }
  let seg: Segment | undefined = segs[lo];
  if (edge === "end" && (!seg || offset < seg.start)) seg = segs[lo - 1] ?? seg;
  if (!seg) return null;
  return { node: seg.node, offset: Math.min(seg.node.length, Math.max(0, offset - seg.start)) };
}

/** Where `quote` sits now, preferring the occurrence closest to where it used to be. */
function relocate(text: string, quote: string, hint: number): number {
  if (!quote) return -1;
  if (text.startsWith(quote, hint)) return hint;
  let best = -1;
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    if (best < 0 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
  }
  return best;
}

// ---- geometry -----------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

interface Box { left: number; top: number; right: number; bottom: number }

function viewportBox(): Box {
  const vv = window.visualViewport;
  if (!vv) return { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight };
  return { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height };
}

/** Ancestors that clip overflow. Collected once per attach; reading computed style per scroll frame is too slow. */
function clippingAncestors(el: Element): Element[] {
  const out: Element[] = [el];
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) out.push(p);
  }
  return out;
}

function visibleRect(clippers: Element[]): DOMRect | null {
  const box = viewportBox();
  for (const el of clippers) {
    const r = el.getBoundingClientRect();
    box.left = Math.max(box.left, r.left);
    box.top = Math.max(box.top, r.top);
    box.right = Math.min(box.right, r.right);
    box.bottom = Math.min(box.bottom, r.bottom);
  }
  if (box.right - box.left < 1 || box.bottom - box.top < 1) return null;
  return new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
}

/**
 * One rect per visual line. A wrapped span yields several client rects per line
 * whenever inline formatting (<strong>, <code>) splits it, so rects that overlap
 * vertically by more than half a line are unioned.
 */
function mergeLines(rects: DOMRect[]): DOMRect[] {
  const lines: Box[] = [];
  for (const r of rects) {
    const line = lines.find((l) =>
      Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > Math.min(l.bottom - l.top, r.height) / 2);
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return lines.map((l) => new DOMRect(l.left, l.top, l.right - l.left, l.bottom - l.top));
}

/** The underline sits on the line's bottom edge, so a line is drawn only while that edge is inside the clip. */
function clipLine(r: DOMRect, clip: DOMRect): DOMRect | null {
  if (r.bottom > clip.bottom + 1 || r.bottom < clip.top + 3) return null;
  const left = Math.max(r.left, clip.left);
  const right = Math.min(r.right, clip.right);
  if (right - left < 1) return null;
  const top = Math.max(r.top, clip.top);
  return new DOMRect(left, top, right - left, r.bottom - top);
}

const scratch = document.createRange();

/**
 * Rects are collected per text node rather than from one Range over the whole
 * span: a Range that fully contains an element (e.g. a middle <p>) reports that
 * element's border box too, which would underline the paragraph's full width.
 */
function lineRects(snap: Snapshot, start: number, end: number, clip: DOMRect): DOMRect[] {
  const boxes: DOMRect[] = [];
  for (const seg of snap.segments) {
    if (seg.end <= start) continue;
    if (seg.start >= end) break;
    if (!seg.node.isConnected) continue;
    const a = Math.min(seg.node.length, Math.max(start, seg.start) - seg.start);
    const b = Math.min(seg.node.length, Math.min(end, seg.end) - seg.start);
    if (b <= a) continue;
    scratch.setStart(seg.node, a);
    scratch.setEnd(seg.node, b);
    for (const r of scratch.getClientRects()) if (r.width > 0.5 && r.height > 0) boxes.push(r);
  }
  return mergeLines(boxes).flatMap((r) => clipLine(r, clip) ?? []);
}

/** Below (or above) the anchor, flipped when it doesn't fit, then clamped into the visual viewport. */
function place(el: HTMLElement, anchor: DOMRect, prefer: "below" | "above", align: "start" | "end"): void {
  const v = viewportBox();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - hgt;
  const fitsBelow = below + hgt <= v.bottom - EDGE;
  const fitsAbove = above >= v.top + EDGE;
  const useBelow = prefer === "below" ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow;

  const top = clamp(useBelow ? below : above, v.top + EDGE, v.bottom - EDGE - hgt);
  const left = clamp(align === "start" ? anchor.left : anchor.right - w, v.left + EDGE, v.right - EDGE - w);
  el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  el.dataset.side = useBelow ? "below" : "above";
}

// ---- DOM helpers (our shadow tree only) -----------------------------------------

const chip = (tier: Tier) => h("span", { class: "ndai-chip", "data-tier": tier }, TIER_WORD[tier]);
const dot = (tier: Tier) => h("span", { class: "ndai-dot", "data-tier": tier, "aria-hidden": "true" });
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function rootEditable(target: EventTarget | null | undefined): HTMLElement | null {
  if (!(target instanceof HTMLElement) || !target.isContentEditable) return null;
  let el = target;
  while (el.parentElement?.isContentEditable) el = el.parentElement;
  return el;
}

// ---- inspector ----------------------------------------------------------------------

interface Mark {
  id: number;
  finding: Finding;
  tier: Tier;
  quote: string;
  start: number;
  end: number;
  lines: DOMRect[];
}

type Status = "idle" | "pending" | "checking" | "ready" | "error";

interface PanelAction { label: string; value: string; kind?: "primary" | "quiet"; disabled?: boolean }

class Inspector {
  active = false;

  private readonly host: HTMLElement;
  private readonly marksLayer: HTMLDivElement;
  private readonly badge: HTMLButtonElement;
  private readonly card: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly toasts: HTMLDivElement;

  private editor: HTMLElement | null = null;
  private clippers: Element[] = [];
  private clip: DOMRect | null = null;
  private snap: Snapshot = { text: "", segments: [] };
  private marks: Mark[] = [];
  private nextMarkId = 1;
  private underlines = new Map<number, HTMLDivElement[]>();
  private ignored = new Set<string>();

  private result: Inspection | null = null;
  private resultText = "";
  private status: Status = "idle";
  private seq = 0;
  private composing = false;

  private debounceTimer = 0;
  private hoverTimer = 0;
  private closeTimer = 0;
  private raf = 0;
  private badgeKey = "";

  private activeId: number | null = null;
  private cardLine = 0;
  private cardPinned = false;
  private panelResolve: ((value: string) => void) | null = null;
  private bypassSend = false;

  private readonly mo = new MutationObserver(() => this.onContentChanged());
  private readonly ro = new ResizeObserver(() => this.scheduleLayout());
  private readonly hostGuard = new MutationObserver(() => {
    if (this.active && !this.host.isConnected) document.documentElement.append(this.host);
  });

  constructor() {
    this.host = document.createElement("ndai-overlay");
    // Inline + !important so page CSS targeting unknown elements can't move it.
    this.host.style.cssText =
      "position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;" +
      "display:block!important;contain:layout style!important;";
    const root = this.host.attachShadow({ mode: "open" });

    this.marksLayer = h("div", { class: "ndai-layer" });
    this.badge = h("button", { class: "ndai-badge", type: "button", hidden: "" });
    this.card = h("div", { class: "ndai-card", role: "dialog", "aria-label": "ndAI finding", hidden: "" });
    this.panel = h("div", { class: "ndai-panel", role: "dialog", "aria-modal": "false", "aria-labelledby": "ndai-panel-title", hidden: "" });
    this.toasts = h("div", { class: "ndai-toasts", "aria-live": "polite" });
    root.append(h("style", {}, css), this.marksLayer, this.badge, this.card, this.panel, this.toasts, this.notices);

    this.badge.addEventListener("click", () => void this.openSummary("review"));
    this.card.addEventListener("keydown", (e) => { if (e.key === "Escape") this.closeCard(true); });
    this.panel.addEventListener("keydown", (e) => { if (e.key === "Escape") this.closePanel("cancel"); });
    this.panel.addEventListener("click", (e) => {
      const button = (e.target as HTMLElement).closest("button");
      if (!button || button.disabled) return;
      if (button.dataset.mark) this.revealMark(Number(button.dataset.mark));
      else if (button.dataset.value) this.closePanel(button.dataset.value);
    });
  }

  // -- lifecycle --------------------------------------------------------------------

  enable(): void {
    if (this.active) return;
    this.active = true;
    document.documentElement.append(this.host);
    this.hostGuard.observe(document.documentElement, { childList: true });

    window.addEventListener("focusin", this.onFocusIn, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("click", this.onClick, true);
    window.addEventListener("pointermove", this.onPointerMove, { capture: true, passive: true });
    window.addEventListener("scroll", this.scheduleLayout, { capture: true, passive: true }); // any scroller
    window.addEventListener("resize", this.onResize, { passive: true });
    window.visualViewport?.addEventListener("resize", this.scheduleLayout, { passive: true });
    window.visualViewport?.addEventListener("scroll", this.scheduleLayout, { passive: true });

    const focused = rootEditable(document.activeElement);
    const known = document.querySelector<HTMLElement>(KNOWN_EDITORS);
    const target = focused ?? (known ? rootEditable(known) : null);
    if (target) this.attach(target);
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.detach();
    this.hostGuard.disconnect();
    window.removeEventListener("focusin", this.onFocusIn, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("click", this.onClick, true);
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("scroll", this.scheduleLayout, true);
    window.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.scheduleLayout);
    window.visualViewport?.removeEventListener("scroll", this.scheduleLayout);
    this.host.remove();
  }

  private attach(el: HTMLElement): void {
    if (this.editor === el) return;
    this.detach();
    this.editor = el;
    this.clippers = clippingAncestors(el);
    this.mo.observe(el, { childList: true, subtree: true, characterData: true });
    this.ro.observe(el);
    el.addEventListener("compositionstart", this.onCompositionStart);
    el.addEventListener("compositionend", this.onCompositionEnd);
    this.onContentChanged();
  }

  private detach(): void {
    const el = this.editor;
    if (!el) return;
    this.mo.disconnect();
    this.ro.disconnect();
    el.removeEventListener("compositionstart", this.onCompositionStart);
    el.removeEventListener("compositionend", this.onCompositionEnd);
    window.clearTimeout(this.debounceTimer);
    this.seq++; // drop in-flight responses
    this.editor = null;
    this.snap = { text: "", segments: [] };
    this.marks = [];
    this.result = null;
    this.resultText = "";
    this.status = "idle";
    this.ignored.clear();
    this.closeCard(false);
    this.closePanel("cancel");
    this.layout();
  }

  // -- input ----------------------------------------------------------------------------

  private onFocusIn = (e: FocusEvent) => {
    const el = rootEditable(e.composedPath()[0]);
    if (el) this.attach(el); // focus moving into our own UI isn't editable, so it never detaches
  };

  private onCompositionStart = () => { this.composing = true; };
  private onCompositionEnd = () => { this.composing = false; this.scheduleDetect(); };

  private onResize = () => {
    if (this.editor) this.clippers = clippingAncestors(this.editor); // media queries can change overflow
    this.scheduleLayout();
  };

  /** MutationObserver fires once per keystroke/transaction; detection is debounced behind it. */
  private onContentChanged(): void {
    const el = this.editor;
    if (!el) return;
    if (!el.isConnected) return this.detach(); // SPA re-rendered the composer; focusin will reattach

    const next = snapshot(el);
    const changed = next.text !== this.snap.text;
    this.snap = next; // segments refresh even when text is identical (editors re-render nodes)
    if (!changed) return this.scheduleLayout();

    this.closeCard(false);
    if (next.text.trim().length < MIN_CHARS) {
      this.marks = [];
      this.status = "idle";
      window.clearTimeout(this.debounceTimer);
      this.seq++;
    } else {
      this.relocateMarks();
      this.status = next.text === this.resultText ? "ready" : "pending";
      if (!this.composing) this.scheduleDetect();
    }
    this.scheduleLayout();
  }

  private relocateMarks(): void {
    this.marks = this.marks.filter((m) => {
      const at = relocate(this.snap.text, m.quote, m.start);
      if (at < 0) return false;
      m.start = at;
      m.end = at + m.quote.length;
      return true;
    });
  }

  private scheduleDetect(): void {
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.detect(), DEBOUNCE_MS);
  }

  private async detect(): Promise<void> {
    window.clearTimeout(this.debounceTimer);
    const text = this.snap.text;
    if (!this.editor || text.trim().length < MIN_CHARS) return;
    if (this.result && text === this.resultText) { this.status = "ready"; return; }

    const seq = ++this.seq;
    this.status = "checking";
    this.scheduleLayout();
    let result: Inspection;
    try {
      result = await inspect(text);
    } catch {
      if (seq === this.seq) { this.status = "error"; this.scheduleLayout(); }
      return;
    }
    if (seq !== this.seq || !this.editor) return; // superseded by a newer check

    const cap = actionTier(result.action);
    this.result = result;
    this.resultText = text;
    this.marks = result.findings.flatMap((finding) => {
      const quote = text.slice(finding.span[0], finding.span[1]);
      const own = findingTier(finding);
      if (!own || !quote || this.ignored.has(findingKey(finding, quote))) return [];
      // Destination policy caps the span: restricted text headed to a private model isn't red.
      const tier = minTier(own, cap);
      if (tier === "green") return [];
      return [{ id: this.nextMarkId++, finding, tier, quote, start: finding.span[0], end: finding.span[1], lines: [] }];
    });
    // The person may have kept typing while the request was out.
    this.relocateMarks();
    this.status = this.snap.text === text ? "ready" : "pending";
    this.scheduleLayout();
  }

  private freshResult(): Inspection | null {
    return this.result && this.resultText === this.snap.text ? this.result : null;
  }

  private currentTier(): Tier {
    return this.marks.reduce<Tier>((t, m) => maxTier(t, m.tier), "green");
  }

  // -- layout: all reads, then all writes, once per frame ---------------------------------

  private scheduleLayout = () => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.layout(); });
  };

  private layout(): void {
    const el = this.editor;
    this.clip = el?.isConnected ? visibleRect(this.clippers) : null;
    for (const m of this.marks) m.lines = this.clip ? lineRects(this.snap, m.start, m.end, this.clip) : [];

    this.renderUnderlines();
    this.renderBadge();
    if (this.activeId !== null) this.positionCard();
    if (!this.panel.hidden) this.positionPanel();
  }

  private renderUnderlines(): void {
    const live = new Set<number>();
    for (const m of this.marks) {
      live.add(m.id);
      const els = this.underlines.get(m.id) ?? [];
      while (els.length < m.lines.length) {
        const u = h("div", { class: "ndai-mark" });
        this.marksLayer.append(u);
        els.push(u);
      }
      while (els.length > m.lines.length) els.pop()!.remove();
      m.lines.forEach((r, i) => {
        const u = els[i];
        u.dataset.tier = m.tier;
        u.classList.toggle("is-active", m.id === this.activeId);
        u.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
        u.style.width = `${r.width}px`;
        u.style.height = `${r.height}px`;
      });
      this.underlines.set(m.id, els);
    }
    for (const [id, els] of this.underlines) {
      if (live.has(id)) continue;
      els.forEach((e) => e.remove());
      this.underlines.delete(id);
    }
  }

  private renderBadge(): void {
    const b = this.badge;
    const clip = this.clip;
    if (!this.editor || !clip || this.status === "idle") { b.hidden = true; return; }

    const tier = this.currentTier();
    const state = this.status === "ready" ? tier : this.status === "error" ? "error" : "checking";
    const count = this.marks.length;
    const key = `${state}:${count}`;
    if (key !== this.badgeKey) {
      this.badgeKey = key;
      b.dataset.state = state;
      b.textContent = state === "green" ? "✓" : state === "checking" ? "" : state === "error" ? "?" : String(count);
      b.setAttribute("aria-label",
        state === "checking" ? "ndAI is checking this prompt"
        : state === "error" ? "ndAI couldn't check this prompt"
        : state === "green" ? "ndAI: nothing sensitive found"
        : `ndAI: ${count} ${count === 1 ? "finding" : "findings"}, ${TIER_WORD[tier].toLowerCase()}`);
    }
    b.hidden = false;
    const { x, y } = this.badgeSpot(clip);
    b.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  /**
   * Bottom-right, unless the last line of text runs under it; then top-right,
   * unless the first line does; then just outside the editor's right edge. The
   * badge takes pointer events, so sitting on text would eat clicks meant for it.
   */
  private badgeSpot(clip: DOMRect): { x: number; y: number } {
    const n = this.snap.text.length;
    const text = [...lineRects(this.snap, 0, Math.min(n, 80), clip), ...lineRects(this.snap, Math.max(0, n - 80), n, clip)];
    const covers = (x: number, y: number) => text.some((r) =>
      r.left < x + BADGE_SIZE + 2 && x - 2 < r.right && r.top < y + BADGE_SIZE + 2 && y - 2 < r.bottom);
    const x = clip.right - BADGE_SIZE - 6;
    const spots = [{ x, y: clip.bottom - BADGE_SIZE - 6 }, { x, y: clip.top + 6 }];
    return spots.find((s) => s.y >= clip.top && !covers(s.x, s.y))
      ?? { x: Math.min(clip.right + 6, viewportBox().right - EDGE - BADGE_SIZE), y: Math.max(clip.top, clip.bottom - BADGE_SIZE) };
  }

  // -- hover card -----------------------------------------------------------------------------

  private markAt(x: number, y: number): Mark | null {
    let best: Mark | null = null;
    for (const m of this.marks) {
      const hit = m.lines.some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 3);
      if (!hit) continue;
      // Overlaps (a key inside a flagged sentence): most severe, then narrowest.
      if (!best || TIER_RANK[m.tier] > TIER_RANK[best.tier]
        || (m.tier === best.tier && m.end - m.start < best.end - best.start)) best = m;
    }
    return best;
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.marks.length || this.panelResolve) return;
    if (e.composedPath().includes(this.host)) { window.clearTimeout(this.closeTimer); this.closeTimer = 0; return; }

    const m = this.markAt(e.clientX, e.clientY);
    if (m) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = 0;
      if (m.id === this.activeId) return;
      window.clearTimeout(this.hoverTimer);
      const { clientX, clientY } = e;
      this.hoverTimer = window.setTimeout(() => this.openCard(m, clientY, false), HOVER_OPEN_MS);
    } else {
      window.clearTimeout(this.hoverTimer);
      if (this.activeId !== null && !this.cardPinned && !this.closeTimer) {
        this.closeTimer = window.setTimeout(() => { this.closeTimer = 0; this.closeCard(false); }, HOVER_CLOSE_MS);
      }
    }
  };

  private openCard(m: Mark, y: number | null, pinned: boolean): void {
    if (this.panelResolve || !this.marks.includes(m)) return;
    window.clearTimeout(this.hoverTimer);
    const line = y === null ? -1 : m.lines.findIndex((r) => y >= r.top - 2 && y <= r.bottom + 3);
    this.activeId = m.id;
    this.cardLine = Math.max(0, line);
    this.cardPinned = pinned;

    const d = describeFinding(m.finding);
    const action = (label: string, kind: string, run: () => void) => {
      const b = h("button", { type: "button", class: `ndai-btn ${kind}` }, label);
      b.addEventListener("click", () => { this.closeCard(false); run(); });
      return b;
    };
    const actions: HTMLButtonElement[] = [];
    if (d.placeholder) {
      const placeholder = d.placeholder;
      actions.push(action(`Replace with ${placeholder}`, "ndai-btn-primary", () => this.replaceSpan(m.start, m.end, placeholder)));
    } else {
      const rewritten = this.freshResult()?.rewritten;
      if (rewritten) actions.push(action("Use safe version", "ndai-btn-primary", () => this.replaceAll(rewritten)));
      actions.push(action("Remove passage", rewritten ? "" : "ndai-btn-primary", () => this.replaceSpan(m.start, m.end, "")));
    }
    // Red is a policy block; dismissing it would just move the block to send time.
    if (m.tier !== "red") actions.push(action("Ignore", "ndai-btn-quiet", () => this.ignore(m)));

    fill(this.card,
      h("div", { class: "ndai-head" }, chip(m.tier), h("span", { class: "ndai-title" }, d.title)),
      h("p", { class: "ndai-text" }, d.detail),
      d.evidence && h("div", { class: "ndai-evidence" }, d.evidence),
      h("div", { class: "ndai-actions" }, ...actions),
    );
    this.card.dataset.tier = m.tier;
    this.card.hidden = false;
    this.renderUnderlines();
    this.positionCard();
    if (pinned) actions[0]?.focus({ preventScroll: true });
  }

  private positionCard(): void {
    const m = this.marks.find((x) => x.id === this.activeId);
    const anchor = m?.lines[Math.min(this.cardLine, m.lines.length - 1)];
    if (!anchor) return this.closeCard(false); // scrolled out of the composer
    place(this.card, anchor, "below", "start");
  }

  private closeCard(refocus: boolean): void {
    window.clearTimeout(this.hoverTimer);
    window.clearTimeout(this.closeTimer);
    this.closeTimer = 0;
    if (this.activeId === null) return;
    this.activeId = null;
    this.cardPinned = false;
    this.card.hidden = true;
    this.renderUnderlines();
    if (refocus) this.editor?.focus({ preventScroll: true });
  }

  private ignore(m: Mark): void {
    this.ignored.add(findingKey(m.finding, m.quote));
    this.marks = this.marks.filter((x) => x !== m);
    this.scheduleLayout();
  }

  // -- panel (summary, send gate, uploads) --------------------------------------------------------

  private openPanel(spec: { tier: Tier; title: string; message?: string; body?: Node[]; actions: PanelAction[] }): Promise<string> {
    this.closePanel("cancel");
    this.closeCard(false);
    const buttons = spec.actions.map((a) => {
      const b = h("button", { type: "button", class: `ndai-btn${a.kind ? ` ndai-btn-${a.kind}` : ""}`, "data-value": a.value }, a.label);
      b.disabled = !!a.disabled;
      return b;
    });
    fill(this.panel,
      h("div", { class: "ndai-head" }, chip(spec.tier), h("h2", { class: "ndai-title", id: "ndai-panel-title" }, spec.title)),
      spec.message && h("p", { class: "ndai-text" }, spec.message),
      ...(spec.body ?? []),
      h("div", { class: "ndai-actions" }, ...buttons),
    );
    this.panel.dataset.tier = spec.tier;
    this.panel.hidden = false;
    this.positionPanel();
    buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
    return new Promise((resolve) => { this.panelResolve = resolve; });
  }

  private positionPanel(): void {
    const b = this.badge;
    if (!b.hidden) return place(this.panel, b.getBoundingClientRect(), "above", "end");
    if (this.clip) return place(this.panel, this.clip, "above", "end");
    const v = viewportBox();
    place(this.panel, new DOMRect(v.right - EDGE, v.bottom - EDGE, 0, 0), "above", "end");
  }

  private closePanel(value: string): void {
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    const resolve = this.panelResolve;
    this.panelResolve = null;
    resolve?.(value);
    if (value === "cancel") this.editor?.focus({ preventScroll: true });
  }

  private summaryBody(r: Inspection): Node[] {
    const body: Node[] = [];
    if (this.marks.length) {
      const sorted = [...this.marks].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.start - b.start);
      body.push(h("ul", { class: "ndai-findings" }, ...sorted.map((m) => {
        const d = describeFinding(m.finding);
        const quote = m.finding.kind === "secret" ? m.finding.preview : `“${truncate(m.quote, 70)}”`;
        return h("li", {}, h("button", { type: "button", class: "ndai-finding", "data-mark": String(m.id) },
          dot(m.tier), h("span", { class: "ndai-finding-title" }, d.title), h("span", { class: "ndai-finding-quote" }, quote)));
      })));
    }
    if (r.rewritten) body.push(h("div", { class: "ndai-label" }, "Safe version"), h("div", { class: "ndai-rewrite" }, r.rewritten));
    return body;
  }

  private async openSummary(mode: "review" | "send"): Promise<"safe" | "original" | "cancel"> {
    if (this.status !== "ready") await this.detect();
    const r = this.freshResult();
    if (!r) return "cancel";
    const tier = this.currentTier();

    const actions: PanelAction[] = [];
    if (r.rewritten) actions.push({ label: mode === "send" ? "Send safe version" : "Use safe version", value: "safe", kind: "primary" });
    if (mode === "send" && tier !== "red") actions.push({ label: "Send original", value: "original" });
    actions.push({ label: mode === "send" ? "Keep editing" : "Close", value: "cancel", kind: "quiet" });

    const title = tier === "green" ? VERDICT.allow : VERDICT[r.action];
    const message = tier === "green" && this.marks.length === 0 && r.findings.length ? "Remaining findings were dismissed." : r.message;
    const choice = await this.openPanel({ tier, title, message, body: this.summaryBody(r), actions });
    if (choice === "safe" && r.rewritten) this.replaceAll(r.rewritten);
    return choice === "safe" || choice === "original" ? choice : "cancel";
  }

  private revealMark(id: number): void {
    const m = this.marks.find((x) => x.id === id);
    this.closePanel("dismiss");
    if (!m) return;
    const pos = locate(this.snap.segments, m.start, "start");
    pos?.node.parentElement?.scrollIntoView({ block: "nearest" });
    requestAnimationFrame(() => { this.layout(); this.openCard(m, null, true); });
  }

  // -- writes back into the host editor ---------------------------------------------------------------

  private replaceSpan(start: number, end: number, replacement: string): void {
    const el = this.editor;
    const a = locate(this.snap.segments, start, "start");
    const b = locate(this.snap.segments, end, "end");
    const sel = window.getSelection();
    if (!el || !a || !b || !sel) return;
    el.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(range);
    // Deprecated but still the only way to produce a *trusted* beforeinput/input
    // that ProseMirror/Slate/Lexical treat as user typing (keeps undo history).
    if (replacement) document.execCommand("insertText", false, replacement);
    else document.execCommand("delete");
  }

  private replaceAll(text: string): void {
    const el = this.editor;
    const sel = window.getSelection();
    if (!el || !sel) return;
    el.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, text);
  }

  // -- send gate ------------------------------------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.activeId !== null) return this.closeCard(true);
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || !this.editor?.contains(e.target as Node)) return;
    this.gate(e, () => this.resend());
  };

  private onClick = (e: MouseEvent) => {
    if (e.composedPath().includes(this.host)) return;
    const target = e.target instanceof Element ? e.target : null;

    if (this.editor && target && this.editor.contains(target)) {
      const m = this.markAt(e.clientX, e.clientY);
      if (m) this.openCard(m, e.clientY, true); // caret still moves; nothing is prevented
      else this.closeCard(false);
      return;
    }
    this.closeCard(false);

    const button = target?.closest<HTMLElement>(SEND_BUTTONS);
    if (button && this.editor) this.gate(e, () => button.click());
  };

  private gate(e: Event, resend: () => void): void {
    if (this.bypassSend) { this.bypassSend = false; return; }
    if (this.snap.text.trim().length < MIN_CHARS) return;
    if (this.status === "ready" && this.currentTier() === "green") return; // fast path: untouched send

    e.preventDefault();
    e.stopImmediatePropagation();
    void this.decideSend(resend);
  }

  private async decideSend(resend: () => void): Promise<void> {
    if (this.status !== "ready") await this.detect();
    if (!this.freshResult()) return; // still typing; the next Enter re-checks
    if (this.currentTier() === "green") return this.release(resend);

    const choice = await this.openSummary("send");
    if (choice === "original") this.release(resend);
    // Let the editor commit the replacement transaction before sending it.
    else if (choice === "safe") requestAnimationFrame(() => requestAnimationFrame(() => this.release(resend)));
  }

  private release(resend: () => void): void {
    this.bypassSend = true;
    resend();
    this.bypassSend = false; // re-dispatch is synchronous; don't leak the bypass into a later send
  }

  private resend(): void {
    const button = document.querySelector<HTMLElement>(SEND_BUTTONS);
    if (button && !(button as HTMLButtonElement).disabled) return button.click();
    this.editor?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  }

  // -- uploads ------------------------------------------------------------------------------------------------

  private readonly notices = h("div", { class: "ndai-notices" });

  /**
   * PDFs and text files are sanitized and held until every change is decided
   * on the review page. Other files (images, archives) fall back to the inline
   * panel, as do documents the sanitizer couldn't read.
   */
  reviewFiles = async (files: File[]): Promise<File[] | null> => {
    let passed: File[] = [];
    let others = files.filter((f) => !isDocument(f));
    const docs = files.filter(isDocument);
    if (docs.length) {
      const result = await this.reviewDocuments(docs);
      if (!result) return null;
      passed = result.files;
      others = [...others, ...result.failed];
    }
    if (!others.length) return passed;
    const rest = await this.reviewOtherFiles(others);
    return rest && [...passed, ...rest];
  };

  private async reviewDocuments(docs: File[]): Promise<{ files: File[]; failed: File[] } | null> {
    const names = docs.map((d) => d.name);
    let summary: ReviewSummary | null = null;
    let settle: ((files: File[] | null) => void) | null = null;

    const notice = showNotice(this.notices, {
      open: () => {
        if (!summary) return;
        openReview(summary);
        notice.update({ kind: "opened", summary });
      },
      cancel: () => {
        if (!summary) return;
        void cancelReview(summary.id);
        settle?.(null);
      },
    });
    notice.update({ kind: "processing", names });

    try {
      summary = await createReview(docs, destination());
    } catch (err) {
      // Fail closed: a document that couldn't be checked isn't uploaded.
      notice.update({ kind: "error", message: `${err instanceof Error ? err.message : String(err)} The upload was cancelled.` });
      return null;
    }
    const s = summary;
    const clean = docs.filter((_, i) => s.inputs[i]?.status === "clean");
    const failed = docs.filter((_, i) => s.inputs[i]?.status === "failed");

    if (!s.inputs.some((r) => r.status === "changes")) {
      notice.remove();
      if (clean.length) this.toast(clean.length === 1 ? `${clean[0].name}: nothing sensitive found` : `${clean.length} files checked: nothing sensitive found`);
      return { files: clean, failed };
    }

    notice.update({ kind: "ready", summary: s });
    const approved = await new Promise<File[] | null>((resolve) => {
      const stop = onReviewEvent((e) => {
        if (e.id === s.id) done(e.type === "review:finished" ? e.files : null);
      });
      const done = (result: File[] | null) => { stop(); settle = null; resolve(result); };
      settle = done;
    });

    if (!approved) {
      notice.update({ kind: "cancelled", names });
      return null;
    }
    notice.update({ kind: "done", names: approved.map((f) => f.name), host: s.host });
    return { files: [...approved, ...clean], failed };
  }

  private reviewOtherFiles = async (files: File[]): Promise<File[] | null> => {
    const reviews = await Promise.all(files.map((f) => reviewFile(f)));
    const worst = reviews.reduce<Tier>((t, r) => maxTier(t, r.tier), "green");
    if (worst === "green") {
      this.toast(files.length === 1 ? `${files[0].name}: nothing sensitive found` : `${files.length} files checked: nothing sensitive found`);
      return files;
    }

    const list = h("ul", { class: "ndai-files" }, ...reviews.map((r) =>
      h("li", { class: "ndai-file" }, dot(r.tier),
        h("div", {},
          h("div", { class: "ndai-file-name" }, r.file.name, h("span", { class: "ndai-file-size" }, formatBytes(r.file.size))),
          h("div", { class: "ndai-file-detail" }, r.detail ? `${r.headline}. ${r.detail}` : r.headline),
          r.safe && h("div", { class: "ndai-file-safe" }, `Safe copy: ${r.safe.name}`)))));

    const anySafe = reviews.some((r) => r.safe);
    const anyRed = reviews.some((r) => r.tier === "red");
    const actions: PanelAction[] = [];
    if (anySafe) actions.push({ label: "Upload safe versions", value: "safe", kind: "primary" });
    actions.push({ label: "Upload originals", value: "original", disabled: anyRed });
    actions.push({ label: "Cancel", value: "cancel", kind: "quiet" });

    const choice = await this.openPanel({
      tier: worst,
      title: anyRed ? "Originals can't be uploaded" : "Check before uploading",
      message: anySafe ? "Safe copies have the flagged passages removed or generalised." : undefined,
      body: [list],
      actions,
    });
    if (choice === "original") return files;
    if (choice === "safe") return reviews.flatMap((r) => (r.safe ? [r.safe] : r.tier === "red" ? [] : [r.file]));
    return null;
  };

  toast(message: string): void {
    const t = h("div", { class: "ndai-toast", role: "status" }, dot("green"), message);
    this.toasts.append(t);
    window.setTimeout(() => t.remove(), 3200);
  }
}

// ---- boot ------------------------------------------------------------------------------------------------------

async function boot(): Promise<void> {
  // The preview page loads this bundle directly; if the extension is also
  // installed there, only the first copy mounts.
  if (document.documentElement.dataset.ndaiMounted) return;
  document.documentElement.dataset.ndaiMounted = "1";

  const inspector = new Inspector();
  installUploadGuard({ isActive: () => inspector.active, review: inspector.reviewFiles });

  const apply = (on: boolean) => (on ? inspector.enable() : inspector.disable());
  if (!hasRuntime()) return apply(true); // preview page: no chrome.* APIs, always on

  const { activated } = await chrome.storage.local.get("activated");
  apply(activated === true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "activated" in changes) apply(changes.activated.newValue === true);
  });
}

void boot();
