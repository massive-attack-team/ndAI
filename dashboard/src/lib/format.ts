import type { Metric } from "../types";

export const fmtTime = (ts: number) => new Date(ts).toISOString().slice(11, 23);

export const fmtDateTime = (ts: number) => new Date(ts).toISOString().slice(0, 23).replace("T", " ");

export function fmtMs(ms: number | null): string {
  if (ms == null) return "--";
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  if (ms < 100) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

/** Two decimals, or three when the third carries information (ndAI's 0.105 margin). */
export function fmtMetric(metric: Metric, value: number): string {
  if (metric.kind === "count") return String(value);
  const three = value.toFixed(3);
  return three.endsWith("0") ? value.toFixed(2) : three;
}

export const fmtConfidence = (c: number | null) => (c == null ? "--" : c.toFixed(2));

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? null;
}

export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
