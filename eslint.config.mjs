import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const HOST_FREE = "Model and webview code must not reach into the extension host; pass plain data across the boundary.";
const SPAWN_ONLY = "Only src/daemon/process.ts may spawn a child process.";

const vscodePath = { name: "vscode", message: HOST_FREE };
const childProcessPaths = [
  { name: "child_process", message: SPAWN_ONLY },
  { name: "node:child_process", message: SPAWN_ONLY },
];

const requireBan = (pattern, message) => ({
  selector: `CallExpression[callee.name='require'] > Literal[value=${pattern}]`,
  message,
});

const noRequireChildProcess = requireBan("/^(node:)?child_process$/", SPAWN_ONLY);
const noRequireVscode = requireBan("/^vscode$/", HOST_FREE);

const noInnerHtml = [
  {
    selector: "MemberExpression[property.name='innerHTML']",
    message: "innerHTML belongs in src/webview only, and only downstream of DOMPurify.",
  },
  {
    selector: "MemberExpression[computed=true] > Literal[value='innerHTML']",
    message: "innerHTML belongs in src/webview only, and only downstream of DOMPurify.",
  },
];

const securityRules = {
  "no-eval": "error",
  "no-new-func": "error",
  "no-console": "error",
};

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "out/**",
      "coverage/**",
      ".vscode-test/**",
      "src/protocol/generated.ts",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...securityRules,
      "@typescript-eslint/no-implied-eval": "error",
      "no-restricted-imports": ["error", { paths: childProcessPaths }],
      "no-restricted-syntax": ["error", noRequireChildProcess],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/webview/**"],
    rules: {
      "no-restricted-syntax": ["error", ...noInnerHtml, noRequireChildProcess],
    },
  },
  {
    files: ["src/model/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [vscodePath, ...childProcessPaths] }],
      "no-restricted-syntax": ["error", ...noInnerHtml, noRequireChildProcess, noRequireVscode],
    },
  },
  {
    files: ["src/webview/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: false,
        project: ["./tsconfig.webview.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-restricted-imports": ["error", { paths: [vscodePath, ...childProcessPaths] }],
      "no-restricted-syntax": ["error", noRequireChildProcess, noRequireVscode],
    },
  },
  {
    files: ["src/daemon/process.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": ["error", ...noInnerHtml],
    },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.mocha },
      parserOptions: {
        projectService: false,
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": "off",
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...securityRules,
      "no-console": "off",
      "no-implied-eval": "error",
    },
  },
);
