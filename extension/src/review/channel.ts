// Transport between the chat tab and the review page.
//
//   extension: content script ⇄ background.ts ⇄ review page
//              (chrome.runtime + chrome.tabs messaging, bytes as base64)
//   preview:   everything is same-origin on localhost, so the session is
//              created in the page and events go over a BroadcastChannel.

import { hasRuntime } from "../detector_client";
import { fromBase64, toBase64 } from "./bytes";
import { createSession } from "./session";
import { deleteSession, putSession } from "./store";
import type { ReviewSession, ReviewSummary } from "./types";

const CHANNEL = "ndai-review";

export type ReviewEvent =
  | { type: "review:finished"; id: string; files: File[] }
  | { type: "review:cancelled"; id: string };

export interface WireFile { name: string; type: string; data: string }
interface Reply<T> { ok: boolean; value?: T; error?: string }

export const toWire = async (f: File): Promise<WireFile> => ({ name: f.name, type: f.type, data: toBase64(await f.arrayBuffer()) });
const fromWire = (w: WireFile) => new File([fromBase64(w.data)], w.name, { type: w.type });

function send<T>(msg: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res?: Reply<T>) => {
      const err = chrome.runtime.lastError;
      if (err || !res) reject(new Error(err?.message ?? "NDAi's background worker didn't respond."));
      else if (!res.ok) reject(new Error(res.error ?? "Request failed."));
      else resolve(res.value as T);
    });
  });
}

function broadcast(event: ReviewEvent): void {
  const bc = new BroadcastChannel(CHANNEL);
  bc.postMessage(event);
  bc.close();
}

// ---- chat tab side ----------------------------------------------------------

export async function createReview(files: File[], host: string): Promise<ReviewSummary> {
  if (hasRuntime()) {
    return send({ type: "review:create", host, files: await Promise.all(files.map(toWire)) });
  }
  const raw = await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, bytes: await f.arrayBuffer() })));
  return createSession(raw, host, null);
}

export function openReview(summary: ReviewSummary): void {
  // Pages can't navigate to chrome-extension:// URLs, so the tab is opened by the worker.
  if (hasRuntime()) void send({ type: "review:open", id: summary.id }).catch(() => undefined);
  else window.open(summary.url, "_blank", "noopener");
}

export async function cancelReview(id: string): Promise<void> {
  if (hasRuntime()) {
    await send({ type: "review:cancel", id }).catch(() => undefined);
    return;
  }
  await deleteSession(id).catch(() => undefined);
  broadcast({ type: "review:cancelled", id });
}

// ---- both sides ----------------------------------------------------------------

export function onReviewEvent(listener: (e: ReviewEvent) => void): () => void {
  if (hasRuntime()) {
    const handle = (msg: { type?: string; id?: string; files?: WireFile[] }) => {
      if (msg?.type === "review:finished" && msg.id && msg.files) listener({ type: msg.type, id: msg.id, files: msg.files.map(fromWire) });
      else if (msg?.type === "review:cancelled" && msg.id) listener({ type: msg.type, id: msg.id });
    };
    chrome.runtime.onMessage.addListener(handle);
    return () => chrome.runtime.onMessage.removeListener(handle);
  }
  const bc = new BroadcastChannel(CHANNEL);
  bc.onmessage = (e: MessageEvent<ReviewEvent>) => listener(e.data);
  return () => bc.close();
}

// ---- review page side ------------------------------------------------------------

export async function finishReview(session: ReviewSession, files: File[]): Promise<void> {
  if (hasRuntime()) {
    await putSession({ ...session, status: "approved", result: files });
    await send({ type: "review:finish", id: session.id });
    return;
  }
  broadcast({ type: "review:finished", id: session.id, files });
  await deleteSession(session.id);
}
