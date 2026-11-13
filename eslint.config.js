const { fixupConfigRules } = require('@eslint/compat');
const reactNative = require('@react-native/eslint-config/flat');

/** UI must not import the native bridge directly (README "Layer boundaries"). */
const uiBoundary = {
  group: ['**/native/ObscuraModule*'],
  message:
    'UI and navigation layers must not import ObscuraModule directly; go through src/state/ or src/domain/.',
};

/** The domain stays pure (docs/DOMAIN_CONTRACT.md). */
const domainBoundary = {
  group: [
    'react',
    'react-native',
    '**/native/**',
    '**/state/**',
    '**/screens/**',
    '**/components/**',
    '**/navigation/**',
  ],
  message: 'src/domain/ must remain pure and independent of React, native, state, and UI.',
};

module.exports = [
  {
    // The native submodule has its own language-specific gates. Its generated build output and
    // vendored dependencies must not become inputs to the app's JavaScript lint.
    ignores: [
      'kotlin/**',
      'swift/**',
      'ios/build/**',
      'android/**/build/**',
      'coverage/**',
      '.claude/**',
    ],
  },
  // Some plugins it bundles (eslint-plugin-ft-flow) still call context methods ESLint 9 removed.
  ...fixupConfigRules(reactNative),
  {
    rules: {
      // Ban silently-swallowed errors. Empty catches hid two real bugs
      // (pix view-once, camera file:// path). Route errors through
      // logError(tag, e) from src/utils/log.ts instead.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause > BlockStatement[body.length=0]',
          message:
            'Do not swallow errors with an empty catch — call logError(tag, e) (src/utils/log.ts) or handle it.',
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression > BlockStatement[body.length=0]",
          message:
            'Do not swallow a promise rejection with .catch(() => {}) — call logError(tag, e) (src/utils/log.ts).',
        },
      ],
    },
  },
  {
    files: [
      'src/screens/**/*.{ts,tsx}',
      'src/components/**/*.{ts,tsx}',
      'src/navigation/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [uiBoundary] }],
    },
  },
  {
    files: ['src/domain/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [domainBoundary] }],
    },
  },
];
