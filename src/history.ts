// History of exercises, kept in IndexedDB so it survives reloads and can
// grow large. Each entry holds the exercise itself plus the settings it was
// made with, so revisiting one puts the trainer back as it was.
import type { Exercise } from './rhythm';

export interface HistoryEntry<S> {
  id: number;
  name: string;
  /** Date.now() when the exercise was made. */
  created: number;
  source: 'generated' | 'custom';
  exercise: Exercise;
  settings: S;
}

const DB_NAME = 'rhythm-trainer';
const STORE = 'history';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Run one request in its own transaction and resolve with its result. */
async function request<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const store = (await db()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export async function addEntry<S>(entry: Omit<HistoryEntry<S>, 'id'>): Promise<HistoryEntry<S>> {
  const id = await request<number>('readwrite', (s) => s.add(entry));
  return { ...entry, id };
}

export const getEntry = <S>(id: number) => request<HistoryEntry<S> | undefined>('readonly', (s) => s.get(id));

/** All entries, newest first. */
export async function listEntries<S>(): Promise<HistoryEntry<S>[]> {
  const all = await request<HistoryEntry<S>[]>('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.id - a.id);
}

export const putEntry = <S>(entry: HistoryEntry<S>) => request<number>('readwrite', (s) => s.put(entry));

export const deleteEntry = (id: number) => request<undefined>('readwrite', (s) => s.delete(id));
