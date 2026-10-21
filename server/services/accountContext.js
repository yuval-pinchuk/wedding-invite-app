import { AsyncLocalStorage } from 'node:async_hooks';

/** @type {AsyncLocalStorage<object | null>} */
export const accountStore = new AsyncLocalStorage();

export function currentAccount() {
  return accountStore.getStore() || null;
}

export function runAsAccount(account, fn) {
  return accountStore.run(account, fn);
}
