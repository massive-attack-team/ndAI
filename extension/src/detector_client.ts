import { DETECTOR_MODE } from "./config";
import { mockInspect } from "./mock_detector";
import type { Inspection } from "./types";

export const hasRuntime = (): boolean => typeof chrome !== "undefined" && !!chrome.runtime?.id;

/** The preview page overrides the hostname so policy can be exercised from localhost. */
export function destination(): string {
  return document.documentElement.dataset.ndaiDestination || location.hostname;
}

/**
 * A page with no chrome.runtime (extension/preview/index.html, deployed
 * standalone rather than loaded as an extension) can't relay through
 * background.js, so it calls POST /inspect directly against __NDAI_API_URL__
 * (build.mjs's `define`, defaults to the local detector). Mirrors
 * background.ts's request shape and fail-closed-on-error behaviour exactly -
 * this is the one other place that talks to the real service, and the two
 * should never drift.
 */
async function fetchInspect(text: string, dest: string): Promise<Inspection> {
  try {
    const res = await fetch(`${__NDAI_API_URL__}/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, destination: dest, user: "unknown", role: "default" }),
    });
    if (!res.ok) throw new Error(`detector returned ${res.status}`);
    return await res.json();
  } catch {
    return {
      action: "block", rule: "detector unavailable",
      message: "NDAi's hosted detector is not reachable, so this text has not been checked.",
      findings: [], degraded: true,
    };
  }
}

/** `dest` is passed explicitly from extension pages, whose own hostname is the extension id. */
export function inspect(text: string, dest: string = destination()): Promise<Inspection> {
  if (DETECTOR_MODE === "live" && hasRuntime()) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "inspect", text, destination: dest, href: location.href }, (res?: Inspection) => {
        if (chrome.runtime.lastError || !res) reject(new Error(chrome.runtime.lastError?.message ?? "no response"));
        else resolve(res);
      });
    });
  }
  if (DETECTOR_MODE === "live") return fetchInspect(text, dest);
  return mockInspect(text, dest);
}
