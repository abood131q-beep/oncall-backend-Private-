'use strict';

module.exports = {
  env: {
    node: true,
    es2021: true,
  },
  parserOptions: {
    ecmaVersion: 2021,
  },
  extends: [
    'eslint:recommended',
    'plugin:node/recommended',
    'plugin:prettier/recommended',
  ],
  plugins: ['node', 'prettier'],
  rules: {
    // ─── Prettier (تنسيق) ───────────────────────────────────────────────
    'prettier/prettier': 'error',

    // ─── أفضل الممارسات ──────────────────────────────────────────────────
    'no-console': 'off', // console.log مسموح — يُوجّه لـ logger لاحقاً
    'no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // السماح بـ destructuring لتوثيق الـ API حتى لو لم تُستخدم مباشرةً
        ignoreRestSiblings: true,
      },
    ],
    'no-var': 'error', // استخدم const/let فقط
    'prefer-const': 'warn', // استخدم const حيثما أمكن
    'eqeqeq': ['error', 'always', { null: 'ignore' }], // === دائماً
    'no-throw-literal': 'error', // throw Error objects فقط
    'no-return-await': 'warn', // تجنب return await غير الضروري
    'no-empty': ['error', { allowEmptyCatch: true }], // كتل catch الفارغة مسموحة

    // ─── Node.js ─────────────────────────────────────────────────────────
    'node/no-unsupported-features/es-syntax': 'off', // Node 22 يدعم كل شيء
    'node/no-missing-require': 'error',
    'node/no-extraneous-require': 'error',
    'node/no-unpublished-require': 'off', // devDependencies مسموحة
    'node/no-process-exit': 'off', // process.exit(1) مسموح في startup validation
    'no-process-exit': 'off', // alias قديم لنفس القاعدة
    'node/no-unsupported-features/node-builtins': 'off', // نستخدم Node 22

    // ─── أمان ────────────────────────────────────────────────────────────
    'no-eval': 'error', // منع eval
    'no-implied-eval': 'error', // منع setTimeout(string)
    'no-new-func': 'error', // منع new Function(string)
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'backups/',
    'logs/',
    'tests/',
    'scripts/',
    'tools/oncall-mcp/',
  ],
};
