import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        // Gives each test file its own empty working directory (TIMING_WORK_DIR)
        setupFiles: ['test/setup.ts'],
        // The services log a lot: only show the logs of failed tests
        silent: 'passed-only',
    },
});
