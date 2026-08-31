module.exports = {
  transform: {
    '^.+\\.ts$': [ 'ts-jest', {
      tsconfig: 'tsconfig.json',
      // Transpile-only: don't hard-fail on missing ambient test types (e.g.
      // @types/jest not installed on servers) and silence the TS151002 hybrid
      // module-kind warning.
      isolatedModules: true,
    }],
  },
  // Only run tests in the unit and integration folders.
  // All test files need to have the suffix `.test.ts`.
  testRegex: '/test/(unit|integration)/.*\\.test\\.ts$',
  moduleFileExtensions: [
    'ts',
    'js',
  ],
  testEnvironment: 'node',
  collectCoverage: true,
  coverageReporters: [ 'text', 'lcov' ],
  coveragePathIgnorePatterns: [
    '/dist/',
    '/node_modules/',
    '/test/',
  ],
  // Make sure our tests have enough time to start a server
  testTimeout: 60000,
};
