// Creates a review session from held files. Runs in the background worker
// (extension) or directly in the page (preview).

import { hasRuntime } from "../detector_client";
import { sanitizeFiles } from "./mock_sanitizer";
import { purgeExpired, putSession } from "./store";
import type { RawFile, ReviewSummary } from "./types";

const reviewUrl = (id: string) =>
  hasRuntime() ? chrome.runtime.getURL(`review.html#${id}`) : new URL(`/review.html#${id}`, location.origin).href;

const newId = () => `r_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export async function createSession(files: RawFile[], host: string, tabId: number | null): Promise<ReviewSummary> {
  await purgeExpired().catch(() => undefined);
  const { documents, inputs } = await sanitizeFiles(files, host);
  const id = newId();
  if (documents.length) await putSession({ id, createdAt: Date.now(), host, tabId, status: "ready", documents });
  return { id, url: reviewUrl(id), host, inputs };
}
