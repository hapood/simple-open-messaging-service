import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

// Flat config (ESLint 9). Replicates the original .eslintrc.js behavior:
// - typescript-eslint recommended (non-type-checked ruleset, so parserOptions.project is not set, avoiding "file not in program" errors)
// - prettier: prettier/prettier:error + disables formatting rules that conflict with it
// - node + jest globals; lenient rules carried over from the old config
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'web/**',
      'src/prisma/generated/**',
    ],
  },
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // v8's no-unused-vars flags unused catch variables by default (v7 did not).
      // Setting caughtErrors:'none' restores v7 behavior, so the migration introduces no new errors on existing code.
      '@typescript-eslint/no-unused-vars': [
        'error',
        // ignoreRestSiblings enables the idiomatic field-omit pattern `const { id, ...rest } = obj`
        // (used to strip the internal Message.id — a throughput side-channel — from responses).
        { caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      // Note: @typescript-eslint/interface-name-prefix was removed in v8, so the former 'off' is no longer needed.
    },
  },
);
