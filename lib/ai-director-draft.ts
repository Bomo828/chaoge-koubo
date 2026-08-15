"use client";

const DATABASE_NAME = "merchant-studio-ai-director";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";
const ACTIVE_DRAFT_KEY = "active";

export type StoredAiDirectorDraft<T> = {
  version: 1;
  updatedAt: number;
  value: T;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不支持本地草稿保存。"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("草稿数据库无法打开。"));
    request.onblocked = () => reject(new Error("草稿数据库正在被其他页面占用，请关闭重复页面后重试。"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("草稿操作失败。"));
      transaction.onabort = () => reject(transaction.error || new Error("草稿操作已中止。"));
    });
  } finally {
    database.close();
  }
}

let saveQueue: Promise<void> = Promise.resolve();

export function saveAiDirectorDraft<T>(value: T) {
  const record: StoredAiDirectorDraft<T> = { version: 1, updatedAt: Date.now(), value };
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    await withStore("readwrite", (store) => store.put(record, ACTIVE_DRAFT_KEY));
  });
  return saveQueue.then(() => record.updatedAt);
}

export async function loadAiDirectorDraft<T>() {
  const record = await withStore<StoredAiDirectorDraft<T> | undefined>("readonly", (store) => store.get(ACTIVE_DRAFT_KEY));
  return record?.version === 1 ? record : null;
}

export async function clearAiDirectorDraft() {
  await withStore("readwrite", (store) => store.delete(ACTIVE_DRAFT_KEY));
}
