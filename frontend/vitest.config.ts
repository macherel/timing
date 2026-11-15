import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      // A simulated browser (document, localStorage, navigator) for the components and the language choice
      environment: 'happy-dom',
      setupFiles: ['test/setup.ts'],
    },
  }),
);
