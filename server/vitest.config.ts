import { defineConfig } from 'vitest/config';

process.env['ALLURE_LABEL_epic'] ??= 'server';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ['__tests__/**/*.test.ts'],
    // Point HOME + USERPROFILE at a throwaway dir for the whole run (inherited
    // by workers and spawned children) and refuse to run if os.homedir() still
    // resolves to the developer's real home. See isolatedHome.globalSetup.ts.
    globalSetup: ['__tests__/isolatedHome.globalSetup.ts'],
    setupFiles: ['__tests__/isolatedHome.setup.ts', 'allure-vitest/setup'],
    reporters: [
      'default',
      [
        'allure-vitest/reporter',
        {
          resultsDir: '../allure-results/server',
        },
      ],
    ],
  },
});
