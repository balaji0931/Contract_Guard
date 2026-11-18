import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Source files use NodeNext-style ".js" specifiers; map them to ".ts" for tests.
    extensionAlias: { ".js": [".ts", ".js"] },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    pool: "forks",
  },
});
