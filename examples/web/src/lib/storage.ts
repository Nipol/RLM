import { coerceStoredProviderRequestTimeoutMs } from './provider_config.ts';
import type { AppSnapshot, ProviderSettings } from './types.ts';

const DB_NAME = 'rlm-web-example';
const STORE_NAME = 'app';
const DB_VERSION = 1;
const SETTINGS_KEY = 'settings';
const TURNS_KEY = 'turns';

const EMPTY_SNAPSHOT: AppSnapshot = {
  settings: null,
  turns: [],
};

function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
  });
}

function normalizeStoredSettings(settings: unknown): ProviderSettings | null {
  if (typeof settings !== 'object' || settings === null) {
    return null;
  }

  const record = settings as Partial<ProviderSettings>;
  return {
    ...record,
    requestTimeoutMs: coerceStoredProviderRequestTimeoutMs(record.requestTimeoutMs),
  } as ProviderSettings;
}

export async function loadAppSnapshot(): Promise<AppSnapshot> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const [settings, turns] = await Promise.all([
      readRequest(store.get(SETTINGS_KEY)),
      readRequest(store.get(TURNS_KEY)),
    ]);

    return {
      settings: normalizeStoredSettings(settings),
      turns: Array.isArray(turns) ? turns : EMPTY_SNAPSHOT.turns,
    };
  } finally {
    database.close();
  }
}

export async function saveAppSnapshot(snapshot: AppSnapshot): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(snapshot.settings, SETTINGS_KEY);
    store.put(snapshot.turns, TURNS_KEY);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}
