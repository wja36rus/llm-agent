// src/ollama/analyzer.ts
import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as fs from 'fs-extra';

export interface FunctionInfo {
  name: string;
  type: 'component' | 'utility' | 'helper' | 'hook';
  params: Array<{ name: string; type?: string; optional?: boolean; defaultValue?: any }>;
  returnType?: string;
  isAsync: boolean;
  isExported: boolean;
  isDefaultExport: boolean;
  body: string;
  jsxElements: string[];
  hooks: string[];
  imports: string[];
  description?: string;
  props?: string[];
  dependencies?: string[];
  conditions?: string[];
  loops?: string[];
  errorHandling?: boolean;
  sideEffects?: boolean;
  testSuggestions?: string[];
}

export class ComponentAnalyzer {
  async analyze(filePath: string): Promise<FunctionInfo[]> {
    const code = await fs.readFile(filePath, 'utf-8');

    const ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'classProperties', 'decorators-legacy'],
    });

    const functions: FunctionInfo[] = [];
    const self = this;

    traverse(ast, {
      FunctionDeclaration(path) {
        if (path.node.id) {
          const info = self.analyzeFunctionWithComplexity(path.node.id.name, path.node, path, code, filePath);
          if (info) functions.push(info);
        }
      },

      VariableDeclarator(path) {
        if (
          t.isIdentifier(path.node.id) &&
          (t.isArrowFunctionExpression(path.node.init) || t.isFunctionExpression(path.node.init))
        ) {
          const info = self.analyzeFunctionWithComplexity(path.node.id.name, path.node.init, path, code, filePath);
          if (info) functions.push(info);
        }
      },

      ExportDefaultDeclaration(path) {
        const declaration = path.node.declaration;
        let funcNode: any = null;
        let funcName = '';

        if (t.isFunctionDeclaration(declaration) && declaration.id) {
          funcNode = declaration;
          funcName = declaration.id.name;
          const info = self.analyzeFunctionWithComplexity(funcName, funcNode, path, code, filePath, true);
          if (info) functions.push(info);
        } else if (t.isArrowFunctionExpression(declaration) || t.isFunctionExpression(declaration)) {
          funcNode = declaration;
          funcName = 'default';
          const info = self.analyzeFunctionWithComplexity(funcName, funcNode, path, code, filePath, true);
          if (info) functions.push(info);
        }
      },

      ExportNamedDeclaration(path) {
        const declaration = path.node.declaration;
        if (declaration && t.isFunctionDeclaration(declaration) && declaration.id) {
          const info = self.analyzeFunctionWithComplexity(declaration.id.name, declaration, path, code, filePath);
          if (info) functions.push(info);
        }
      },
    });

    return functions;
  }

  private analyzeFunctionWithComplexity(
    name: string,
    node: any,
    path: NodePath,
    code: string,
    filePath: string,
    isDefaultExport: boolean = false,
  ): FunctionInfo | null {
    const baseInfo = this.analyzeFunction(name, node, path, code, isDefaultExport);
    if (!baseInfo) return null;

    const complexity = this.analyzeComplexity(node, filePath);
    const testSuggestions = this.generateTestSuggestions(baseInfo, complexity);

    return {
      ...baseInfo,
      conditions: complexity.conditions,
      loops: complexity.loops,
      errorHandling: complexity.errorHandling,
      sideEffects: complexity.sideEffects,
      testSuggestions,
    };
  }

  private analyzeFunction(
    name: string,
    node: any,
    path: NodePath,
    code: string,
    isDefaultExport: boolean = false,
  ): FunctionInfo | null {
    let type: 'component' | 'utility' | 'helper' | 'hook' = 'utility';

    if (this.isComponentName(name)) {
      type = 'component';
    }

    if (name.startsWith('use') && name !== 'use') {
      type = 'hook';
    }

    let hasJSX = false;
    let jsxElements: string[] = [];
    let props: string[] = [];

    try {
      const tempPath = path.get('init') || path;

      if (
        tempPath &&
        (tempPath.isArrowFunctionExpression() || tempPath.isFunctionExpression() || tempPath.isFunctionDeclaration())
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
            jsxElements.push('Fragment');
          },
        });
      }

      if (hasJSX) {
        type = 'component';
      }
    } catch (error) {
      console.log(`   Warning: Could not traverse node for JSX detection in ${name}`);
    }

    const params: Array<{ name: string; type?: string; optional?: boolean; defaultValue?: any }> = [];
    if (node.params) {
      node.params.forEach((param: any) => {
        let paramName = '';
        let paramType: string | undefined = undefined;
        let optional = false;
        let defaultValue: any = undefined;

        if (t.isIdentifier(param)) {
          paramName = param.name;
        } else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
          paramName = param.left.name;
          optional = true;
          if (param.right) {
            if (t.isLiteral(param.right)) {
              defaultValue = (param.right as any).value;
            } else if (t.isIdentifier(param.right)) {
              defaultValue = param.right.name;
            } else if (
              t.isUnaryExpression(param.right) &&
              param.right.operator === '-' &&
              t.isLiteral(param.right.argument)
            ) {
              defaultValue = -(param.right.argument as any).value;
            } else {
              defaultValue = undefined;
            }
          }
        } else if (t.isObjectPattern(param)) {
          paramName = '{ ... }';
        } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
          paramName = `...${param.argument.name}`;
        }

        if (param.typeAnnotation) {
          paramType = this.extractTypeString(param.typeAnnotation);
          if (paramName === 'props' && paramType) {
            props.push(paramType);
          }
        }

        if (paramName) {
          params.push({ name: paramName, type: paramType, optional, defaultValue });
        }
      });
    }

    let returnType: string | undefined = undefined;
    if (node.returnType) {
      returnType = this.extractTypeString(node.returnType);
    } else if (hasJSX) {
      returnType = 'JSX.Element';
    }

    const isAsync = node.async || false;

    let body = '';
    if (node.body) {
      if (t.isBlockStatement(node.body)) {
        body = code.slice(node.body.start, node.body.end);
      } else if (t.isExpression(node.body)) {
        body = code.slice(node.body.start, node.body.end);
      }
    }

    const hooks: string[] = [];

    const imports: string[] = [];

    if (path.scope && path.scope.path) {
      const programPath = path.scope.path.findParent((p: NodePath) => p.isProgram());
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
                  importedName = 'unknown';
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
      props,
      description: undefined,
      dependencies: [],
      conditions: [],
      loops: [],
      errorHandling: false,
      sideEffects: false,
      testSuggestions: [],
    };
  }

  private analyzeComplexity(
    node: any,
    filePath: string,
  ): {
    conditions: string[];
    loops: string[];
    errorHandling: boolean;
    sideEffects: boolean;
  } {
    const conditions: string[] = [];
    const loops: string[] = [];
    let errorHandling = false;
    let sideEffects = false;

    try {
      traverse(node, {
        IfStatement() {
          conditions.push('if-statement');
        },
        ConditionalExpression() {
          conditions.push('ternary');
        },
        SwitchStatement() {
          conditions.push('switch');
        },
        ForStatement() {
          loops.push('for-loop');
        },
        ForInStatement() {
          loops.push('for-in-loop');
        },
        ForOfStatement() {
          loops.push('for-of-loop');
        },
        WhileStatement() {
          loops.push('while-loop');
        },
        DoWhileStatement() {
          loops.push('do-while-loop');
        },
        TryStatement() {
          errorHandling = true;
        },
        CallExpression(callPath) {
          if (t.isIdentifier(callPath.node.callee)) {
            const calleeName = callPath.node.callee.name;
            if (['fetch', 'axios', 'localStorage', 'sessionStorage', 'document', 'window'].includes(calleeName)) {
              sideEffects = true;
            }
          }
        },
        AssignmentExpression(assignPath) {
          if (t.isIdentifier(assignPath.node.left)) {
            const varName = assignPath.node.left.name;
            const binding = assignPath.scope.getBinding(varName);
            if (!binding) {
              sideEffects = true;
            }
          }
        },
      });
    } catch (error) {
      console.log(`   Warning: Could not analyze complexity for ${filePath}`);
    }

    return { conditions, loops, errorHandling, sideEffects };
  }

  private generateTestSuggestions(info: FunctionInfo, complexity: any): string[] {
    const suggestions: string[] = [];

    for (const param of info.params) {
      if (param.type === 'string') {
        suggestions.push(`Test with empty string for ${param.name}`);
        suggestions.push(`Test with very long string for ${param.name}`);
        suggestions.push(`Test with special characters in ${param.name}`);
      } else if (param.type === 'number') {
        suggestions.push(`Test with zero for ${param.name}`);
        suggestions.push(`Test with negative number for ${param.name}`);
        suggestions.push(`Test with NaN for ${param.name}`);
      } else if (param.type === 'boolean') {
        suggestions.push(`Test with true for ${param.name}`);
        suggestions.push(`Test with false for ${param.name}`);
      } else if (param.type?.includes('[]')) {
        suggestions.push(`Test with empty array for ${param.name}`);
        suggestions.push(`Test with array of one item for ${param.name}`);
      }
    }

    if (complexity.conditions.length > 0) {
      suggestions.push(`Test all conditional branches (${complexity.conditions.length} conditions found)`);
    }

    if (complexity.loops.length > 0) {
      suggestions.push(`Test edge cases in loops (empty collection, single item, many items)`);
    }

    if (info.isAsync) {
      suggestions.push(`Test successful async operation`);
      suggestions.push(`Test async operation error handling`);
    }

    if (complexity.errorHandling) {
      suggestions.push(`Test error scenarios (try/catch blocks)`);
    }

    if (complexity.sideEffects) {
      suggestions.push(`Test side effects (localStorage, API calls, etc.)`);
    }

    return suggestions;
  }

  private extractTypeString(typeAnnotation: any): string {
    if (t.isTSTypeReference(typeAnnotation)) {
      if (t.isIdentifier(typeAnnotation.typeName)) {
        return typeAnnotation.typeName.name;
      }
    } else if (t.isTSStringKeyword(typeAnnotation)) {
      return 'string';
    } else if (t.isTSNumberKeyword(typeAnnotation)) {
      return 'number';
    } else if (t.isTSBooleanKeyword(typeAnnotation)) {
      return 'boolean';
    } else if (t.isTSVoidKeyword(typeAnnotation)) {
      return 'void';
    } else if (t.isTSArrayType(typeAnnotation)) {
      return `${this.extractTypeString(typeAnnotation.elementType)}[]`;
    } else if (t.isTSUndefinedKeyword(typeAnnotation)) {
      return 'undefined';
    } else if (t.isTSNullKeyword(typeAnnotation)) {
      return 'null';
    } else if (t.isTSAnyKeyword(typeAnnotation)) {
      return 'any';
    } else if (t.isTSFunctionType(typeAnnotation)) {
      return 'function';
    } else if (t.isTSObjectKeyword(typeAnnotation)) {
      return 'object';
    }
    return 'any';
  }

  private isComponentName(name: string): boolean {
    return /^[A-Z][a-zA-Z0-9_]*$/.test(name) && !['Fragment', 'StrictMode', 'Suspense'].includes(name);
  }
}
