// src/testValidator.ts
import { exec } from 'child_process';
import * as fs from 'fs-extra';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
  syntaxErrors?: string[];
}

export class TestValidator {
  async validateTest(testCode: string, testPath: string): Promise<ValidationResult> {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: [],
    };

    // 1. Проверка синтаксиса
    const syntaxErrors = await this.checkSyntax(testCode);
    if (syntaxErrors.length > 0) {
      result.isValid = false;
      result.syntaxErrors = syntaxErrors;
      result.errors.push('Syntax errors found');
      return result;
    }

    // 2. Проверка импортов
    this.validateImports(testCode, result);

    // 3. Проверка структуры
    this.validateStructure(testCode, result);

    // 4. Проверка наличия describe и it
    if (!testCode.includes('describe(')) {
      result.warnings.push('No describe block found. Tests should be grouped in describe()');
    }

    if (!testCode.includes('it(') && !testCode.includes('test(')) {
      result.errors.push('No test cases found. Add it() or test() blocks');
      result.isValid = false;
    }

    // 5. Проверка на использование правильных matchers
    this.validateMatchers(testCode, result);

    // 6. Проверка на наличие expects
    const expectCount = (testCode.match(/expect\(/g) || []).length;
    if (expectCount === 0) {
      result.warnings.push('No assertions found. Add expect() statements');
    }

    // 7. Проверка на асинхронные тесты
    if (testCode.includes('async') && !testCode.includes('await')) {
      result.warnings.push('Async function without await detected');
    }

    // 8. Проверка на изоляцию тестов
    if (this.hasSharedState(testCode)) {
      result.warnings.push('Potential shared state between tests. Use beforeEach/afterEach for setup/cleanup');
    }

    // 9. Предложения по улучшению
    this.generateSuggestions(testCode, result);

    return result;
  }

  private async checkSyntax(code: string): Promise<string[]> {
    const errors: string[] = [];
    const tempFile = `temp-test-${Date.now()}.ts`;

    try {
      await fs.writeFile(tempFile, code);
      await execAsync(`npx tsc --noEmit ${tempFile}`);
    } catch (error: any) {
      const lines = error.stdout?.split('\n') || [];
      for (const line of lines) {
        if (line.includes('error TS')) {
          errors.push(line);
        }
      }
    } finally {
      await fs.remove(tempFile).catch(() => {});
    }

    return errors;
  }

  private validateImports(code: string, result: ValidationResult): void {
    const requiredImports = [
      { pattern: /from ['"]vitest['"]/, name: 'vitest' },
      { pattern: /from ['"]@testing-library\/react['"]/, name: '@testing-library/react' },
    ];

    if (code.includes('render(') || code.includes('screen.')) {
      if (!code.includes('@testing-library/react')) {
        result.errors.push('Missing import: @testing-library/react');
        result.isValid = false;
      }
    }

    if (code.includes('jest.fn()')) {
      result.warnings.push('Use vi.fn() instead of jest.fn() for Vitest');
    }

    if (code.includes('toBeInTheDocument') && !code.includes('@testing-library/jest-dom')) {
      result.errors.push('Missing import: @testing-library/jest-dom');
      result.isValid = false;
    }
  }

  private validateStructure(code: string, result: ValidationResult): void {
    // Проверка на AAA паттерн (Arrange, Act, Assert)
    const lines = code.split('\n');
    let hasArrange = false;
    let hasAct = false;
    let hasAssert = false;

    for (const line of lines) {
      if (line.includes('const ') || line.includes('let ') || line.includes('vi.fn()')) {
        hasArrange = true;
      }
      if (line.includes('fireEvent.') || line.includes('userEvent.') || line.includes('.click(')) {
        hasAct = true;
      }
      if (line.includes('expect(')) {
        hasAssert = true;
      }
    }

    if (!hasArrange && code.includes('it(')) {
      result.suggestions.push('Consider using AAA pattern: Arrange (setup), Act (action), Assert (verify)');
    }
  }

  private validateMatchers(code: string, result: ValidationResult): void {
    const matchers = {
      toBe: 'Use toBe() for primitive values',
      toEqual: 'Use toEqual() for objects and arrays',
      toBeTruthy: 'Use toBeTruthy() for truthy values',
      toBeFalsy: 'Use toBeFalsy() for falsy values',
      toBeNull: 'Use toBeNull() for null values',
      toBeUndefined: 'Use toBeUndefined() for undefined values',
    };

    // Проверка на неправильное использование matchers
    if (code.includes('expect(') && code.includes('.toBe(')) {
      const toBeMatches = code.match(/expect\([^)]+\)\.toBe\([^)]+\)/g);
      if (toBeMatches) {
        for (const match of toBeMatches) {
          if (match.includes('{') || match.includes('[')) {
            result.warnings.push(`Consider using toEqual() instead of toBe() for objects/arrays: ${match}`);
          }
        }
      }
    }
  }

  private hasSharedState(code: string): boolean {
    // Проверка на переменные вне describe или beforeEach
    const lines = code.split('\n');
    let insideDescribe = false;

    for (const line of lines) {
      if (line.includes('describe(')) {
        insideDescribe = true;
      }
      if (insideDescribe && (line.includes('let ') || line.includes('const '))) {
        if (!line.includes('inside') && !line.includes('beforeEach')) {
          return true;
        }
      }
    }

    return false;
  }

  private generateSuggestions(code: string, result: ValidationResult): void {
    if (!code.includes('test.each') && code.includes('it(')) {
      const itCount = (code.match(/it\(/g) || []).length;
      if (itCount > 5 && code.includes('expect(')) {
        result.suggestions.push('Consider using test.each() for similar test cases to reduce duplication');
      }
    }

    if (code.includes('.getByTestId')) {
      result.suggestions.push('Prefer getByRole with name over getByTestId for better accessibility');
    }

    if (!code.includes('userEvent') && code.includes('fireEvent')) {
      result.suggestions.push('Consider using userEvent instead of fireEvent for more realistic user interactions');
    }

    if (!code.includes('screen.') && code.includes('render')) {
      result.suggestions.push('Use screen object for queries (screen.getByRole, etc.) for cleaner code');
    }
  }
}
