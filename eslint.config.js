import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage", "**/cdk.out"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["load/**"], languageOptions: { globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly" } } },
);
