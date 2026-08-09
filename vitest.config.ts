import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    // PostgreSQL integration files share the intentional one-active-tournament constraint.
    // Serial files keep that product invariant intact instead of weakening the database index for tests.
    fileParallelism: false,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
