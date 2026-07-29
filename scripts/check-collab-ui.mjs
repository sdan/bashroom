// Compile the TypeScript HTML factory, evaluate one role page, then parse the
// exact inline browser program. This catches template-escape failures that
// tsc cannot see because the JavaScript lives inside a string.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// web-collab.ts has real value imports (@codemirror/state for the selective
// undo engine), so the transpiled CommonJS needs a working require.
const require = createRequire(import.meta.url);
const source = readFileSync(process.argv[2], "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function("exports", "module", "require", compiled)(module.exports, module, require);
const { webCollaborativeShareHtml } = module.exports;
const html = webCollaborativeShareHtml({ slug: "test-slug", role: "edit", nonce: "test-nonce" });
const match = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>\s*<\/body>/);
if (!match) throw new Error("collaboration inline script not found");
new Function(match[1]);
if (!match[1].includes('This document is empty.')) {
  throw new Error("collaboration empty-document rendering missing");
}

// The anonymous View page's scripts live inside src/index.ts rather than the
// collaboration factory. Extract just those two pure string factories via
// the TypeScript AST, evaluate them, then parse the exact JavaScript bytes a
// browser receives. This keeps Worker imports out of the check.
const indexPath = process.argv[3];
if (!indexPath) throw new Error("index.ts path is required");
const indexSource = readFileSync(indexPath, "utf8");
const indexFile = ts.createSourceFile(indexPath, indexSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
function functionText(name) {
  const declaration = indexFile.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(name + " not found");
  return declaration.getText(indexFile);
}
const publicFactoriesSource = functionText("publicRichMarkdownScript") + "\n" + functionText("publicLiveScript")
  + "\nmodule.exports = { publicRichMarkdownScript, publicLiveScript };";
const publicFactoriesCompiled = ts.transpileModule(publicFactoriesSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const publicModule = { exports: {} };
new Function("exports", "module", publicFactoriesCompiled)(publicModule.exports, publicModule);
new Function(publicModule.exports.publicRichMarkdownScript("# test"));
new Function(publicModule.exports.publicLiveScript("test-slug", "notes/test.md"));

console.log("parsed", match[1].length, "collaboration UI chars and public live scripts");
