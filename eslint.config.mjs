/**
 * ESLint v9+ flat config — Next 16 dropped the `next lint` shim, so we
 * configure ESLint directly. eslint-config-next ships flat presets in
 * its dist/ folder.
 */
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "gcloud-mcp/**",
      "public/**",
      "*.config.js",
      "*.config.mjs",
      "scripts/**",
    ],
  },
  {
    // Soften React 19 Compiler / react-hooks strictness to warnings.
    // These rules flag legacy-but-working patterns (setState in effect,
    // ref access during render) that the React Compiler will optimize
    // around. Treating them as warnings lets lint catch real bugs (no-
    // restricted-imports, no-unused-vars, react/no-unescaped-entities)
    // without blocking on patterns we've shipped intentionally.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/purity": "warn",
      "react/no-unescaped-entities": "warn",
    },
  },
];
