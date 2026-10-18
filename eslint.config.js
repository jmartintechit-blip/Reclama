import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '.netlify/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Plan 4.1: money must be exact and the domain must not read the clock by itself.
    files: ['server/domain/**/*.ts', 'server/services/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Money is integer cents; do not parse amounts as floats (use parseMoney).',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message:
            'Money is integer cents; do not parse amounts as floats (use parseMoney).',
        },
        {
          property: 'toFixed',
          message: 'toFixed rounds binary floats; format cents with formatEUR.',
        },
        {
          object: 'Math',
          property: 'round',
          message:
            'Math.round(1.005 * 100) gives 100, not 101. Use integer arithmetic with explicit rounding.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Do not read the clock here; receive a `clock` argument.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'new Date() reads the clock; receive a `clock` argument instead.',
        },
      ],
    },
  },
  {
    // The browser app: hooks rules, accessibility rules, and no float parsing or formatting for
    // money (the clock ban above is server-only; the web reads dates it is given).
    files: ['web/**/*.{ts,tsx}'],
    extends: [
      reactHooks.configs.flat.recommended,
      jsxA11y.flatConfigs.recommended,
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money is integer cents; do not parse amounts as floats.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money is integer cents; do not parse amounts as floats.',
        },
        {
          property: 'toFixed',
          message: 'toFixed rounds binary floats; format cents with formatEUR.',
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
