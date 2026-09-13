// "mock": everything runs in the page, no network, no backend needed.
// "live": content script -> background.js -> http://127.0.0.1:8000/inspect.
//         Note background.js doesn't pass `log: false`, so live mode writes an
//         audit event per debounced check, not per send.
export const DETECTOR_MODE: "mock" | "live" = "mock";
