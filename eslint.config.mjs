import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

// Flat config (ESLint 9)。复刻原 .eslintrc.js 行为：
// - typescript-eslint recommended（非类型检查规则集，故不设 parserOptions.project，避免「文件不在 program」报错）
// - prettier：prettier/prettier:error + 关闭与之冲突的格式化规则
// - node + jest 全局；宽松规则沿用旧配置
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
      // v8 的 no-unused-vars 默认会标记未用的 catch 变量（v7 不会）。
      // 设 caughtErrors:'none' 还原 v7 行为，避免迁移在既有代码上引入新报错。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { caughtErrors: 'none' },
      ],
      // 注：@typescript-eslint/interface-name-prefix 在 v8 已移除，原 'off' 无需保留。
    },
  },
);
