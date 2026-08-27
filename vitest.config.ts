import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@/config': path.resolve(__dirname, 'src/config/index.ts'),
      '@/models': path.resolve(__dirname, 'src/models/index.ts'),
      '@/services': path.resolve(__dirname, 'src/services'),
      '@/utils': path.resolve(__dirname, 'src/utils'),
      '@/cli': path.resolve(__dirname, 'src/cli'),
      '@/dashboard': path.resolve(__dirname, 'src/dashboard'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 74,
        statements: 80,
      },
    },
    include: ['tests/**/*.test.ts'],
  },
});
