import React from 'react';

export interface HookHarness {
  readonly stateTransforms: Array<(prev: boolean) => boolean>;
  readonly refObj: { current: boolean };
  cleanup(): void;
}

/** Minimal synchronous React hook harness for testing Zustand selectors and effect hooks in Node. */
export function installHookHarness(): HookHarness {
  const cleanups: Array<() => void> = [];
  const stateTransforms: Array<(prev: boolean) => boolean> = [];
  const refObj = { current: false };

  jest.spyOn(React, 'useSyncExternalStore').mockImplementation((_sub, getSnap) => getSnap());
  jest.spyOn(React, 'useCallback').mockImplementation((fn) => fn);
  jest.spyOn(React, 'useDebugValue').mockImplementation(() => {});
  jest.spyOn(React, 'useMemo').mockImplementation((fn) => fn());
  jest.spyOn(React, 'useRef').mockImplementation((init?: unknown) => (
    typeof init === 'boolean' ? refObj : { current: init }
  ) as any);
  jest.spyOn(React, 'useState').mockImplementation(((init?: unknown) => {
    const val = typeof init === 'function' ? (init as () => unknown)() : init;
    const set = (next: unknown) => {
      if (typeof next === 'function') stateTransforms.push(next as (prev: boolean) => boolean);
    };
    return [val, set];
  }) as typeof React.useState);
  jest.spyOn(React, 'useEffect').mockImplementation((fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  });

  return {
    stateTransforms,
    refObj,
    cleanup() {
      while (cleanups.length > 0) {
        cleanups.pop()?.();
      }
    },
  };
}
