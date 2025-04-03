import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: [
            'node_modules/**',
            'build/**',
            'dist/**',
            'NetscriptDefinitions.d.ts',
            // 'src/lib/react.ts'
        ]
    },
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.es2021
            },
            parser: tseslint.parser,
        },
        rules: {
            'indent': ['error', 4, {
                'SwitchCase': 1
            }],
            'quotes': ['error', 'single'],
            'semi': ['error', 'always'],
            '@typescript-eslint/no-unused-vars': 'off'
        }
    }
); 