import { DETECTOR_MODE } from "./config";
import { mockInspect } from "./mock_detector";
import type { Inspection } from "./types";

export const hasRuntime = (): boolean => typeof chrome !== "undefined" && !!chrome.runtime?.id;

/** The preview page overrides the hostname so policy can be exercised from localhost. */
export function destination(): string {
  return document.documentElement.dataset.ndaiDestination || location.hostname;
}

export function inspect(text: string): Promise<Inspection> {
  if (DETECTOR_MODE === "live" && hasRuntime()) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "inspect", text, href: location.href }, (res?: Inspection) => {
        if (chrome.runtime.lastError || !res) reject(new Error(chrome.runtime.lastError?.message ?? "no response"));
        else resolve(res);
      });
    });
  }
  return mockInspect(text, destination());
}
