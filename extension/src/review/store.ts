// Review sessions live in IndexedDB on the extension origin, shared by the
// background worker, the offscreen sanitizer and review pages. They hold the
// original file, so they're deleted as soon as a review ends and purged after
// an hour regardless.

import type { ReviewSession } from "./types";

const DB_NAME = "ndai-review";
const STORE = "sessions";
const TTL_MS = 60 * 60 * 1000;

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  }));
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getSession = (id: string) => run("readonly", (s) => s.get(id)) as Promise<ReviewSession | undefined>;
export const putSession = (session: ReviewSession) => run("readwrite", (s) => s.put(session)).then(() => undefined);
export const deleteSession = (id: string) => run("readwrite", (s) => s.delete(id)).then(() => undefined);

export async function purgeExpired(): Promise<void> {
  const all = (await run("readonly", (s) => s.getAll())) as ReviewSession[];
  await Promise.all(all.filter((x) => Date.now() - x.createdAt > TTL_MS).map((x) => deleteSession(x.id)));
}
