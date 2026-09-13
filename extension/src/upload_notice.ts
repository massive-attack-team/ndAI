// On-screen notice for a held upload. Lives in the content script's shadow
// root, top-right, and follows one upload from "sanitizing" to "sent".

import { h } from "./dom";
import type { ReviewSummary } from "./review/types";

export type NoticeState =
  | { kind: "processing"; names: string[] }
  | { kind: "ready" | "opened"; summary: ReviewSummary }
  | { kind: "done"; names: string[]; host: string }
  | { kind: "cancelled"; names: string[] }
  | { kind: "error"; message: string };

export interface Notice {
  update(state: NoticeState): void;
  remove(): void;
}

const DOC_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>`;
const CHECK_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ALERT_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/></svg>`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const listNames = (names: string[]) => (names.length === 1 ? names[0] : plural(names.length, "file"));
const middleEllipsis = (s: string, max = 44) => (s.length <= max ? s : `${s.slice(0, max - 18)}…${s.slice(-17)}`);

export function showNotice(container: HTMLElement, on: { open(): void; cancel(): void }): Notice {
  const el = h("section", { class: "ndai-notice", role: "region", "aria-label": "ndAI upload review", "aria-live": "polite" });
  container.append(el);
  let timer = 0;

  const remove = () => { window.clearTimeout(timer); el.remove(); };

  const btn = (label: string, kind: string, run: () => void) => {
    const b = h("button", { type: "button", class: `ndai-btn ${kind}` }, label);
    b.addEventListener("click", run);
    return b;
  };

  const update = (s: NoticeState) => {
    window.clearTimeout(timer);
    el.dataset.state = s.kind;

    const icon = h("div", { class: "ndai-notice-icon", "aria-hidden": "true" });
    icon.innerHTML = s.kind === "done" ? CHECK_ICON : s.kind === "error" ? ALERT_ICON : s.kind === "processing" ? "" : DOC_ICON;
    const body = h("div", { class: "ndai-notice-body" });
    const eyebrow = (text: string) => h("p", { class: "ndai-notice-eyebrow" }, text);
    const title = (text: string) => h("h2", { class: "ndai-notice-title" }, text);
    const text = (t: string) => h("p", { class: "ndai-notice-text" }, t);
    const close = h("button", { type: "button", class: "ndai-notice-close", "aria-label": "Dismiss" }, "×");
    close.addEventListener("click", remove);

    switch (s.kind) {
      case "processing":
        body.append(eyebrow("Upload on hold"), title(`Sanitizing ${listNames(s.names)}…`),
          text("Checking for confidential passages and credentials. Nothing has been uploaded."));
        break;

      case "ready":
      case "opened": {
        const docs = s.summary.inputs.filter((i) => i.status === "changes");
        const total = docs.reduce((n, d) => n + (d.status === "changes" ? d.changes : 0), 0);
        const link = h("a", {
          class: "ndai-notice-link", href: s.summary.url, target: "_blank", rel: "noopener noreferrer", title: s.summary.url,
        }, middleEllipsis(s.summary.url));
        link.addEventListener("click", (e) => { e.preventDefault(); on.open(); });

        body.append(
          eyebrow(s.kind === "ready" ? "Upload on hold · approval needed" : "Review open in another tab"),
          title(`${listNames(docs.map((d) => d.name))} was sanitized`),
          text(`${plural(total, "change")} need${total === 1 ? "s" : ""} your approval before ${docs.length === 1 ? "it's" : "they're"} uploaded to ${s.summary.host}.`),
          ...(docs.length > 1 ? [h("ul", { class: "ndai-notice-docs" }, ...docs.map((d) =>
            h("li", {}, h("span", {}, d.name), h("span", {}, plural(d.status === "changes" ? d.changes : 0, "change")))))] : []),
          h("div", { class: "ndai-notice-linkrow" }, h("span", { class: "ndai-notice-linklabel" }, "Review page"), link),
          h("div", { class: "ndai-actions" },
            btn(s.kind === "ready" ? "Review changes" : "Reopen review", "ndai-btn-primary", on.open),
            btn("Cancel upload", "ndai-btn-quiet", on.cancel)),
        );
        break;
      }

      case "done":
        body.append(eyebrow("Approved"), title("Sanitized copy attached"),
          text(`${listNames(s.names)} is going to ${s.host} with your approved changes applied.`));
        el.append(close);
        timer = window.setTimeout(remove, 6000);
        break;

      case "cancelled":
        body.append(eyebrow("Cancelled"), title("Upload cancelled"), text(`Nothing from ${listNames(s.names)} was uploaded.`));
        timer = window.setTimeout(remove, 4000);
        break;

      case "error":
        body.append(eyebrow("Upload cancelled"), title("Couldn't sanitize this file"), text(s.message));
        break;
    }

    el.replaceChildren(icon, body);
    if (s.kind === "done" || s.kind === "cancelled" || s.kind === "error") el.append(close);
  };

  return { update, remove };
}
