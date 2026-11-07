/**
 * The `react-native` module as Jest sees it, so tests exercise the real `ObscuraModule.ts` against
 * `FakeObscuraBridge`. Implements only what the tested modules touch.
 */

import { FakeObscuraBridge } from './FakeObscuraBridge';

/** One instance, reset in place between tests: `ObscuraModule` captures it at import. */
const fakeBridge = new FakeObscuraBridge();

/** The fake the module under test is talking to. */
export function getFakeBridge(): FakeObscuraBridge {
  return fakeBridge;
}

export const TurboModuleRegistry = {
  get(name: string): unknown {
    return name === 'ObscuraBridge' ? fakeBridge : null;
  },
  getEnforcing(name: string): unknown {
    const m = TurboModuleRegistry.get(name);
    if (!m) throw new Error(`TurboModuleRegistry.getEnforcing(${name}): not found in the RN mock`);
    return m;
  },
};

/** Delegates to the fake's `addListener`, as the real emitter does to the native module. */
export class NativeEventEmitter {
  constructor(private readonly nativeModule: FakeObscuraBridge) {}

  addListener(eventName: string, handler: (event: any) => void): { remove: () => void } {
    return this.nativeModule.addListener(eventName, handler);
  }
}

export const Platform = { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default };

type AlertButton = { text?: string; style?: string; onPress?: () => void };
type AlertOptions = { cancelable?: boolean; onDismiss?: () => void };
type AlertHandler = (title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) => void;

const alertQueue: AlertHandler[] = [];

export const Alert = {
  __enqueue(handler: AlertHandler): void {
    alertQueue.push(handler);
  },
  __reset(): void {
    alertQueue.length = 0;
  },
  alert(
    title: string,
    message?: string,
    buttons?: AlertButton[],
    options?: AlertOptions,
  ): void {
    alertQueue.shift()?.(title, message, buttons, options);
  },
};


