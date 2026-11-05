// The DECLARATION CLOSURE of the model adapter interface (review S6): every interface and type alias the
// interface's exported types reach, printed without comments, one after another in a stable order. A
// change anywhere in the closure (a `TurnRequest` field, a `ProviderEvent` variant, a catalog row field)
// changes this text, so `interface.test.ts` fails until the committed snapshot is updated on purpose,
// and the version is bumped with it when the change is not purely additive.
//
// Test support only (TypeScript's compiler API is a dev dependency): never imported by shipped code.
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The exported names whose closure is the contract. */
export const INTERFACE_ROOTS = {
  "types.ts": ["ModelAdapter", "AdapterContext", "AdapterDiscoveryContext", "AdapterSecrets", "KeyedFetch", "KeyedFetchInit", "KeyedFetchOptions"],
  "keyed-fetch.ts": ["KeyedToken", "KeyedTokenSource", "KeyPlacement", "KeyHeader", "KeyedAuthEntry", "KeyedFetchErrorCode"],
} as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(REPO, "tsconfig.base.json");
  const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8"));
  const converted = ts.convertCompilerOptionsFromJson(parsed.config.compilerOptions ?? {}, REPO);
  return { ...converted.options, noEmit: true, baseUrl: REPO };
}

/** The closure, as text: `// <file> <name>` then the declaration printed without comments, sorted by file and name. */
export function adapterInterfaceClosure(): string {
  const roots = Object.keys(INTERFACE_ROOTS).map((file) => join(HERE, file));
  const program = ts.createProgram(roots, compilerOptions());
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const seen = new Map<ts.Node, string>();
  const queue: ts.Node[] = [];

  const ownFile = (sf: ts.SourceFile): boolean => !sf.isDeclarationFile && sf.fileName.startsWith(join(REPO, "packages")) && !sf.fileName.includes("node_modules");
  const enqueue = (symbol: ts.Symbol | undefined): void => {
    if (symbol === undefined) return;
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    for (const decl of target.declarations ?? []) {
      if (!(ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || ts.isEnumDeclaration(decl))) continue;
      if (!ownFile(decl.getSourceFile()) || seen.has(decl)) continue;
      seen.set(decl, "");
      queue.push(decl);
    }
  };

  for (const [file, names] of Object.entries(INTERFACE_ROOTS)) {
    const sf = program.getSourceFile(join(HERE, file));
    if (sf === undefined) throw new Error(`interface snapshot: ${file} is not in the program`);
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    const exports = moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol);
    for (const name of names) {
      const symbol = exports.find((e) => e.name === name);
      if (symbol === undefined) throw new Error(`interface snapshot: ${file} exports no ${name}`);
      enqueue(symbol);
    }
  }

  while (queue.length > 0) {
    const decl = queue.shift()!;
    const visit = (node: ts.Node): void => {
      if (ts.isTypeReferenceNode(node)) enqueue(checker.getSymbolAtLocation(ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName));
      else if (ts.isExpressionWithTypeArguments(node)) enqueue(checker.getSymbolAtLocation(node.expression));
      else if (ts.isTypeQueryNode(node)) enqueue(checker.getSymbolAtLocation(ts.isQualifiedName(node.exprName) ? node.exprName.right : node.exprName));
      ts.forEachChild(node, visit);
    };
    visit(decl);
  }

  const entries: string[] = [];
  for (const decl of seen.keys()) {
    const sf = decl.getSourceFile();
    const name = (decl as ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration).name.text;
    const text = printer.printNode(ts.EmitHint.Unspecified, decl, sf).trim();
    entries.push(`// ${relative(REPO, sf.fileName)} ${name}\n${text}`);
  }
  entries.sort();
  return `${entries.join("\n\n")}\n`;
}
