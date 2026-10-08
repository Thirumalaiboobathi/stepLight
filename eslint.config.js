import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/**", "**/dist/**", "**/viewer-dist/**", "**/coverage/**", "**/node_modules/**", ".steplight/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
