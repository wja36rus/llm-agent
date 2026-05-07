import * as fs from "fs-extra";
import * as parser from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";

export interface FunctionInfo {
  name: string;
  type: "component" | "utility" | "helper" | "hook";
  params: Array<{ name: string; type?: string; optional?: boolean }>;
  returnType?: string;
  isAsync: boolean;
  isExported: boolean;
  isDefaultExport: boolean;
  body: string;
  jsxElements: string[];
  hooks: string[];
  imports: string[];
  description?: string;
}

export class ComponentAnalyzer {
  async analyze(filePath: string): Promise<FunctionInfo[]> {
    const code = await fs.readFile(filePath, "utf-8");

    // Парсим код в AST
    const ast = parser.parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "classProperties", "decorators-legacy"],
    });

    const functions: FunctionInfo[] = [];
    const self = this;

    // Собираем информацию
    traverse(ast, {
      // Функциональные декларации
      FunctionDeclaration(path) {
        if (path.node.id) {
          const info = self.analyzeFunction(
            path.node.id.name,
            path.node,
            path,
            code,
          );
          if (info) functions.push(info);
        }
      },

      // Стрелочные функции и функциональные выражения (экспортируемые)
      VariableDeclarator(path) {
        if (
          t.isIdentifier(path.node.id) &&
          (t.isArrowFunctionExpression(path.node.init) ||
            t.isFunctionExpression(path.node.init))
        ) {
          const info = self.analyzeFunction(
            path.node.id.name,
            path.node.init,
            path,
            code,
          );
          if (info) functions.push(info);
        }
      },

      // Экспорт по умолчанию
      ExportDefaultDeclaration(path) {
        const declaration = path.node.declaration;
        let funcNode: any = null;
        let funcName = "";

        if (t.isFunctionDeclaration(declaration) && declaration.id) {
          funcNode = declaration;
          funcName = declaration.id.name;
          const info = self.analyzeFunction(
            funcName,
            funcNode,
            path,
            code,
            true,
          );
          if (info) functions.push(info);
        } else if (
          t.isArrowFunctionExpression(declaration) ||
          t.isFunctionExpression(declaration)
        ) {
          funcNode = declaration;
          funcName = "default";
          const info = self.analyzeFunction(
            funcName,
            funcNode,
            path,
            code,
            true,
          );
          if (info) functions.push(info);
        }
      },

      // Экспорт именованных функций
      ExportNamedDeclaration(path) {
        const declaration = path.node.declaration;
        if (
          declaration &&
          t.isFunctionDeclaration(declaration) &&
          declaration.id
        ) {
          const info = self.analyzeFunction(
            declaration.id.name,
            declaration,
            path,
            code,
          );
          if (info) functions.push(info);
        }
      },
    });

    return functions;
  }

  private analyzeFunction(
    name: string,
    node: any,
    path: NodePath,
    code: string,
    isDefaultExport: boolean = false,
  ): FunctionInfo | null {
    // Определяем тип функции
    let type: "component" | "utility" | "helper" | "hook" = "utility";

    // Проверка на React компонент
    if (this.isComponentName(name)) {
      type = "component";
    }

    // Проверка на хук
    if (name.startsWith("use") && name !== "use") {
      type = "hook";
    }

    // Проверка на наличие JSX (компонент) - используем path для обхода
    let hasJSX = false;
    let jsxElements: string[] = [];

    // Создаем новый обходчик для узла с правильным контекстом
    try {
      // Используем path.scope и передаем текущий path для правильного контекста
      const tempPath = path.get("init") || path;

      if (
        (tempPath && tempPath.isArrowFunctionExpression()) ||
        tempPath.isFunctionExpression() ||
        tempPath.isFunctionDeclaration()
      ) {
        tempPath.traverse({
          JSXElement(elPath) {
            hasJSX = true;
            if (t.isJSXIdentifier(elPath.node.openingElement.name)) {
              jsxElements.push(elPath.node.openingElement.name.name);
            }
          },
          JSXFragment() {
            hasJSX = true;
            jsxElements.push("Fragment");
          },
        });
      }

      if (hasJSX) {
        type = "component";
      }
    } catch (error) {
      // Если не удалось обойти, игнорируем
      console.log(
        `   Warning: Could not traverse node for JSX detection in ${name}`,
      );
    }

    // Собираем параметры
    const params: Array<{ name: string; type?: string; optional?: boolean }> =
      [];
    if (node.params) {
      node.params.forEach((param: any) => {
        let paramName = "";
        let paramType: string | undefined = undefined;
        let optional = false;

        if (t.isIdentifier(param)) {
          paramName = param.name;
        } else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
          paramName = param.left.name;
          optional = true;
        } else if (t.isObjectPattern(param)) {
          paramName = "{ ... }";
        } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
          paramName = `...${param.argument.name}`;
        }

        // Пытаемся найти тип параметра из TypeScript аннотации
        if (param.typeAnnotation) {
          paramType = this.extractTypeString(param.typeAnnotation);
        }

        if (paramName) {
          params.push({ name: paramName, type: paramType, optional });
        }
      });
    }

    // Определяем возвращаемый тип
    let returnType: string | undefined = undefined;
    if (node.returnType) {
      returnType = this.extractTypeString(node.returnType);
    } else if (hasJSX) {
      returnType = "JSX.Element";
    }

    // Проверяем асинхронность
    const isAsync = node.async || false;

    // Получаем тело функции
    let body = "";
    if (node.body) {
      if (t.isBlockStatement(node.body)) {
        body = code.slice(node.body.start, node.body.end);
      } else if (t.isExpression(node.body)) {
        body = code.slice(node.body.start, node.body.end);
      }
    }

    // Собираем хуки внутри функции
    const hooks: string[] = [];

    // Собираем импорты из файла
    const imports: string[] = [];
    let importsNodes: any[] = [];

    // Собираем импорты из родительского AST
    if (path.scope && path.scope.path) {
      const programPath = path.scope.path.findParent((p: NodePath) =>
        p.isProgram(),
      );
      if (programPath) {
        programPath.traverse({
          ImportDeclaration(importPath) {
            const source = importPath.node.source.value;
            importPath.node.specifiers.forEach((spec) => {
              if (t.isImportSpecifier(spec)) {
                let importedName: string;
                if (t.isIdentifier(spec.imported)) {
                  importedName = spec.imported.name;
                } else if (t.isStringLiteral(spec.imported)) {
                  importedName = spec.imported.value;
                } else {
                  importedName = "unknown";
                }
                const importStr = `${importedName} from ${source}`;
                if (!imports.includes(importStr)) {
                  imports.push(importStr);
                }
              } else if (t.isImportDefaultSpecifier(spec)) {
                const importStr = `${spec.local.name} from ${source}`;
                if (!imports.includes(importStr)) {
                  imports.push(importStr);
                }
              } else if (t.isImportNamespaceSpecifier(spec)) {
                const importStr = `* as ${spec.local.name} from ${source}`;
                if (!imports.includes(importStr)) {
                  imports.push(importStr);
                }
              }
            });
          },
        });
      }
    }

    // Проверяем экспорт
    let isExported = false;
    if (path.parentPath) {
      if (
        path.parentPath.isExportNamedDeclaration() ||
        path.parentPath.isExportDefaultDeclaration() ||
        path.parentPath.parentPath?.isExportNamedDeclaration()
      ) {
        isExported = true;
      }
    }

    return {
      name,
      type,
      params,
      returnType,
      isAsync,
      isExported,
      isDefaultExport,
      body,
      jsxElements,
      hooks,
      imports,
      description: undefined,
    };
  }

  private extractTypeString(typeAnnotation: any): string {
    if (t.isTSTypeReference(typeAnnotation)) {
      if (t.isIdentifier(typeAnnotation.typeName)) {
        return typeAnnotation.typeName.name;
      }
    } else if (t.isTSStringKeyword(typeAnnotation)) {
      return "string";
    } else if (t.isTSNumberKeyword(typeAnnotation)) {
      return "number";
    } else if (t.isTSBooleanKeyword(typeAnnotation)) {
      return "boolean";
    } else if (t.isTSVoidKeyword(typeAnnotation)) {
      return "void";
    } else if (t.isTSArrayType(typeAnnotation)) {
      return `${this.extractTypeString(typeAnnotation.elementType)}[]`;
    } else if (t.isTSUndefinedKeyword(typeAnnotation)) {
      return "undefined";
    } else if (t.isTSNullKeyword(typeAnnotation)) {
      return "null";
    } else if (t.isTSAnyKeyword(typeAnnotation)) {
      return "any";
    }
    return "any";
  }

  private isComponentName(name: string): boolean {
    // React компоненты начинаются с заглавной буквы и не являются зарезервированными словами
    return (
      /^[A-Z][a-zA-Z0-9_]*$/.test(name) &&
      !["Fragment", "StrictMode", "Suspense"].includes(name)
    );
  }
}
