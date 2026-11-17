import type { Node } from "web-tree-sitter";
import type { languages, IRange } from "monaco-editor";

// 数值遵循 Monaco SymbolKind；不把编辑器运行时引进 Worker。
const Kind = { Module: 1, Class: 4, Method: 5, Field: 7, Constructor: 8,
  Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13,
  EnumMember: 21, Struct: 22, TypeParameter: 25 };
const nodeKinds: Record<string, number> = {
  function_item: Kind.Function, function_signature_item: Kind.Function,
  struct_item: Kind.Struct, enum_item: Kind.Enum, enum_variant: Kind.EnumMember,
  trait_item: Kind.Interface, mod_item: Kind.Module, type_item: Kind.TypeParameter,
  macro_definition: Kind.Function,
  const_item: Kind.Constant, static_item: Kind.Variable, field_declaration: Kind.Field,
  class_definition: Kind.Class, function_definition: Kind.Function,
  class_declaration: Kind.Class, abstract_class_declaration: Kind.Class,
  function_declaration: Kind.Function, generator_function_declaration: Kind.Function,
  method_definition: Kind.Method, method_declaration: Kind.Method,
  method_signature: Kind.Method, abstract_method_signature: Kind.Method, property_signature: Kind.Field,
  constructor_declaration: Kind.Constructor, constructor_definition: Kind.Constructor,
  interface_declaration: Kind.Interface, type_alias_declaration: Kind.TypeParameter,
  enum_declaration: Kind.Enum, enum_assignment: Kind.EnumMember,
  struct_specifier: Kind.Struct, class_specifier: Kind.Class, enum_specifier: Kind.Enum,
  enumerator: Kind.EnumMember, namespace_definition: Kind.Module,
  type_spec: Kind.Struct, const_spec: Kind.Constant, var_spec: Kind.Variable,
  record_declaration: Kind.Class, struct_declaration: Kind.Struct,
  namespace_declaration: Kind.Module, enum_constant: Kind.EnumMember, method_elem: Kind.Method,
  property_declaration: Kind.Field, field_definition: Kind.Field,
  public_field_definition: Kind.Field,
};

function field(node: Node, name: string) { return node.childForFieldName(name); }

/** C/C++ 的函数名藏在指针 / 引用 / 函数 declarator 链里，不能取第一个 identifier。 */
function declaratorName(node: Node | null): Node | null {
  if (!node) return null;
  if (["identifier", "field_identifier", "type_identifier", "qualified_identifier",
    "destructor_name", "operator_name"].includes(node.type)) return node;
  return declaratorName(field(node, "declarator")) ?? declaratorName(field(node, "name")) ??
    (node.type === "parenthesized_declarator" ? declaratorName(node.namedChildren[0] ?? null) : null);
}

function describe(node: Node, language: string, insideFunction: boolean): { name: Node; kind: number; label?: string } | null {
  let kind = nodeKinds[node.type];
  let name = field(node, "name");
  // typedef 已以别名占一个节点，内嵌结构体只补字段，避免 Point / Point 两层重复。
  if (["struct_specifier", "class_specifier", "enum_specifier"].includes(node.type) && node.parent?.type === "type_definition") return null;
  if (language === "rust" && node.type === "impl_item") {
    name = field(node, "type");
    const trait = field(node, "trait");
    return name ? { name, kind: Kind.Class, label: `impl ${trait ? `${trait.text} for ` : ""}${name.text}` } : null;
  }
  if ((language === "c" || language === "cpp") && node.type === "function_definition") {
    name = declaratorName(field(node, "declarator"));
  }
  if ((language === "c" || language === "cpp") && node.type === "field_declaration") {
    const declarator = field(node, "declarator");
    name = declaratorName(declarator);
    if (declarator?.type === "function_declarator") kind = Kind.Method;
  }
  if (node.type === "pair") {
    const value = field(node, "value");
    if (!value || !["arrow_function", "function_expression", "generator_function"].includes(value.type)) return null;
    name = field(node, "key");
    kind = Kind.Method;
  }
  if ((language === "c" || language === "cpp") && node.type === "function_declarator" && !insideFunction) {
    // 函数指针字段已经由外层字段声明展示，不再重复生成同名函数。
    let parent = node.parent;
    while (parent && parent.type.includes("declarator")) parent = parent.parent;
    if (parent?.type === "field_declaration") return null;
    name = declaratorName(field(node, "declarator"));
    kind = Kind.Function;
  }
  if (node.type === "variable_declarator") {
    const value = field(node, "value");
    const callable = value && ["arrow_function", "function_expression", "generator_function"].includes(value.type);
    if (insideFunction && !callable) return null;
    kind = callable ? Kind.Function : value?.type === "class" ? Kind.Class : Kind.Variable;
  }
  if (node.type === "type_definition") {
    name = declaratorName(field(node, "declarator"));
    kind = Kind.TypeParameter;
  }
  if (kind === undefined || !name || name.isMissing) return null;
  return { name, kind };
}

function range(node: Node): IRange {
  // web-tree-sitter 的 JS 绑定按 UTF-16 读字符串，列号与 Monaco 一致（含中文和代理对）。
  return { startLineNumber: node.startPosition.row + 1, startColumn: node.startPosition.column + 1,
    endLineNumber: node.endPosition.row + 1, endColumn: node.endPosition.column + 1 };
}

export function collectSymbols(root: Node, language: string): languages.DocumentSymbol[] {
  const result: languages.DocumentSymbol[] = [];
  const stack = [{ node: root, target: result, insideFunction: false }];
  while (stack.length > 0) {
    const { node, target, insideFunction } = stack.pop()!;
    // 注释、字符串和宏的正文不是声明，不能从里面制造大纲项。
    if (node.type.includes("comment") || node.type.includes("string") || node.type === "token_tree") continue;
    const description = describe(node, language, insideFunction);
    let children = target;
    let inFunction = insideFunction;
    if (description) {
      const symbol: languages.DocumentSymbol = {
        name: description.label ?? description.name.text, detail: "", kind: description.kind,
        tags: [], range: range(node), selectionRange: range(description.name), children: [],
      };
      target.push(symbol);
      children = symbol.children!;
      inFunction ||= description.kind === Kind.Function || description.kind === Kind.Method || description.kind === Kind.Constructor;
    }
    // 反向入栈保持源码顺序；迭代遍历避免深层语法导致 JS 调用栈溢出。
    const named = node.namedChildren;
    for (let index = named.length - 1; index >= 0; --index) {
      const child = named[index];
      if (!child) continue;
      // 已作为变量函数展示，避免具名函数表达式重复出现。
      if (description && child.id === description.name.id) continue;
      stack.push({ node: child, target: children, insideFunction: inFunction });
    }
  }
  return result;
}

