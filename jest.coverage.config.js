const jestConfig = require('./jest.config');

module.exports = {
  ...jestConfig,
  collectCoverage: true,
  coverageReporters: [ 'text', 'lcov' ],
  coveragePathIgnorePatterns: [
    '/dist/',
    '/node_modules/',
    '/test/',
  ],
  coverageThreshold: {
    './src': {
      branches: 1.83,
      functions: 2.81,
      lines: 29.21,
      statements: 28.88,
    },
  },
};
