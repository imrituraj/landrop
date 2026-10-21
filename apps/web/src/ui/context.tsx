import { createContext, useContext } from 'react';
import type { AppController } from '../core/controller.ts';
import type { AppState } from '../core/state.ts';
import { useStore } from '../core/store.ts';

export const ControllerContext = createContext<AppController | null>(null);

export function useApp(): AppController {
  const app = useContext(ControllerContext);
  if (!app) throw new Error('ControllerContext missing');
  return app;
}

/** Selectors must return stable references (store slices), not new objects. */
export function useAppState<T>(selector: (s: AppState) => T): T {
  return useStore(useApp().store, selector);
}
