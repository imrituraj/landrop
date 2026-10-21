import { useSyncExternalStore } from 'react';

/**
 * Minimal external store. Services (signaling, peers, transfers, chat) live
 * outside React and push immutable snapshots here; components subscribe with
 * `useStore`. React re-renders therefore never create or destroy connections.
 */
export class Store<T> {
  private state: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.state = initial;
  }

  get = (): T => this.state;

  update(fn: (prev: T) => T): void {
    const next = fn(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useStore<T, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
