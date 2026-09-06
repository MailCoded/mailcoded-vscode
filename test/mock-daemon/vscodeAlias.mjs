import Module, { register } from "node:module";
import { fileURLToPath } from "node:url";

const fake = new URL("./fakeVscode.ts", import.meta.url);

register(new URL("./vscodeAliasHooks.mjs", import.meta.url), { data: { target: fake.href } });

const fakePath = fileURLToPath(fake);
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function aliasVscode(request, ...rest) {
  if (request === "vscode") return fakePath;
  return resolveFilename.call(this, request, ...rest);
};
