module.exports = {
  root: true,
  extends: '@react-native',
  // The native submodule has its own language-specific gates. Its generated build output and
  // vendored dependencies must not become inputs to the app's JavaScript lint.
  ignorePatterns: ['kotlin/**', 'swift/**', 'ios/build/**', 'coverage/**'],
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
  overrides: [
    {
      files: [
        'src/screens/**/*.{ts,tsx}',
        'src/components/**/*.{ts,tsx}',
        'src/navigation/**/*.{ts,tsx}',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/native/ObscuraModule*'],
                message:
                  'UI and navigation layers must not import ObscuraModule directly; go through src/state/ or src/domain/.',
              },
              {
                // claude: one exception, ui2/legacyColors, which themes the old screens (no bare `**/ui2`: it would block the exception too).
                group: ['**/ui2/**', '!**/ui2/legacyColors'],
                message: 'The current UI must not import src/ui2/ (except ui2/legacyColors); only RootNavigator may import it.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/navigation/RootNavigator.tsx'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/native/ObscuraModule*'],
                message:
                  'UI and navigation layers must not import ObscuraModule directly; go through src/state/ or src/domain/.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/ui2/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '**/styles', '**/components', '**/components/**',
                  // claude: ../components from a src/ui2 subfolder is src/ui2/components
                  '!../components', '!../components/**',
                ],
                message: 'src/ui2/ must not import the current UI (src/styles, src/components/).',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/ui2/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/styles', '**/components', '**/components/**'],
                message: 'src/ui2/ must not import the current UI (src/styles, src/components/).',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/domain/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
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
              },
            ],
          },
        ],
      },
    },
  ],
};
