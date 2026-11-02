/**
 * Node-side test suite: the app's domain layer and the bridge boundary.
 *
 * `src/domain` is pure application logic (`docs/DOMAIN_CONTRACT.md`), with
 * no React Native imports or mocks, and `src/models` the schema it is parameterised
 * by. `src/native` is the bridge wrapper and `src/state` the
 * effects that drive it, both tested against the in-memory kit double
 * (`src/native/__fixtures__/FakeObscuraBridge.ts`) that `jest.setup.ts` installs in place of the
 * real native module.
 *
 * Still absent, and deliberately: anything that RENDERS. Covering a component needs a React
 * renderer (`react-test-renderer` or `@testing-library/react-native`) that this repo does not yet
 * depend on. That is a dependency decision, and it belongs in its own change with its own jest
 * project entry. The event switch and cold-start pull are plain functions
 * covered by `src/state/__tests__/store.test.ts`; only hook wiring needs a renderer.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  roots: [
    '<rootDir>/src/domain',
    '<rootDir>/src/native',
    '<rootDir>/src/state',
  ],
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};
