let target = "";

export function initialize(data) {
  target = data.target;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier === "vscode") return { url: target, shortCircuit: true };
  return nextResolve(specifier, context);
}
