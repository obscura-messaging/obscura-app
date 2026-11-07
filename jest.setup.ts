/**
 * Installs the in-memory kit double for every suite.
 *
 * `jest.mock` here rather than in each test file because `ObscuraModule.ts` binds its bridge at
 * import time — a per-file mock has to be declared before the import that triggers it, which is
 * exactly the ordering footgun that makes people reach for `require()` in the middle of a test.
 * Doing it once in setup means suites can `import { Obscura } from '../ObscuraModule'` normally.
 *
 * See `src/native/__fixtures__/FakeObscuraBridge.ts` for what the double is and, more importantly,
 * what it must not become.
 */

jest.mock('react-native', () => require('./src/native/__fixtures__/reactNativeMock'));

console.warn = () => {};

beforeEach(() => {
  const { Alert, getFakeBridge } = require('./src/native/__fixtures__/reactNativeMock');
  getFakeBridge().__reset();
  Alert.__reset();
});
