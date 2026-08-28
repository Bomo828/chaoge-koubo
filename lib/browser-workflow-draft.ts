"use client";

const DATABASE_NAME = "merchant-studio-workflows";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";

export type StoredWorkflowDraft<T> = {
  version: 1;
  updatedAt: number;
  value: T;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不支持制作进度保存。"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("制作进度数据库无法打开。"));
    request.onblocked = () => reject(new Error("制作进度正在被其他页面占用，请关闭重复页面后重试。"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("制作进度保存失败。"));
      transaction.onabort = () => reject(transaction.error || new Error("制作进度保存已中止。"));
    });
  } finally {
    database.close();
  }
}

const saveQueues = new Map<string, Promise<void>>();

export function saveWorkflowDraft<T>(key: string, value: T) {
  const record: StoredWorkflowDraft<T> = { version: 1, updatedAt: Date.now(), value };
  const previous = saveQueues.get(key) || Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    await withStore("readwrite", (store) => store.put(record, key));
  });
  saveQueues.set(key, queued);
  return queued.then(() => record.updatedAt);
}

export async function loadWorkflowDraft<T>(key: string) {
  const record = await withStore<StoredWorkflowDraft<T> | undefined>("readonly", (store) => store.get(key));
  return record?.version === 1 ? record : null;
}

export async function clearWorkflowDraft(key: string) {
  await withStore("readwrite", (store) => store.delete(key));
}
