import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs-extra";
import * as path from "path";
import { OllamaClient } from "./ollamaClient";

const execAsync = promisify(exec);

export interface TestResult {
  success: boolean;
  output: string;
  error?: string;
  failedTests: FailedTest[];
  duration: number;
}

export interface FailedTest {
  name: string;
  error: string;
  stackTrace?: string;
  filePath: string;
}

export interface FixAttempt {
  attemptNumber: number;
  originalCode: string;
  fixedCode: string;
  success: boolean;
  error?: string;
}

export class TestRunner {
  private ollama: OllamaClient;
  private maxFixAttempts: number;
  private testResults: Map<string, TestResult> = new Map();

  constructor(model: string = "qwen2.5-coder:7b", maxFixAttempts: number = 3) {
    this.ollama = new OllamaClient(model);
    this.maxFixAttempts = maxFixAttempts;
  }

  async runTest(testFilePath: string): Promise<TestResult> {
    console.log(`\n🧪 Running test: ${path.basename(testFilePath)}`);

    const startTime = Date.now();

    try {
      // Проверяем наличие jest
      try {
        await execAsync("npx jest --version");
      } catch (error) {
        console.log("⚠️  Jest not found. Installing required packages...");
        await execAsync(
          "npm install --save-dev jest ts-jest @types/jest @testing-library/jest-dom @testing-library/react @testing-library/user-event jest-environment-jsdom identity-obj-proxy",
        );
      }

      // Запускаем тест с полным путем
      const { stdout, stderr } = await execAsync(
        `npx jest "${testFilePath}" --no-coverage --colors --passWithNoTests`,
        {
          env: { ...process.env, CI: "true" },
          cwd: process.cwd(),
          timeout: 30000,
        },
      );

      const duration = Date.now() - startTime;

      const result: TestResult = {
        success: true,
        output: stdout,
        duration,
        failedTests: [],
      };

      console.log(`✅ Test passed in ${duration}ms`);
      this.testResults.set(testFilePath, result);
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;

      console.log(
        "Error output:",
        error.stdout || error.stderr || error.message,
      );

      // Проверяем специфические ошибки
      const errorMessage = error.stderr || error.stdout || error.message;

      if (errorMessage.includes("ts-jest not found")) {
        console.log("⚠️  ts-jest not found. Installing...");
        await execAsync("npm install --save-dev ts-jest");
        // Повторяем попытку
        return this.runTest(testFilePath);
      }

      if (errorMessage.includes("Cannot find module")) {
        console.log("⚠️  Missing module. Please run: npm install");
      }

      const failedTests = this.parseFailedTests(
        error.stdout || error.stderr,
        testFilePath,
      );

      const result: TestResult = {
        success: false,
        output: error.stdout || "",
        error: errorMessage,
        failedTests,
        duration,
      };

      console.log(`❌ Test failed in ${duration}ms`);
      this.testResults.set(testFilePath, result);
      return result;
    }
  }

  async runAndFix(
    testFilePath: string,
    originalCodePath?: string,
  ): Promise<FixAttempt[]> {
    const attempts: FixAttempt[] = [];
    let currentCode = await fs.readFile(testFilePath, "utf-8");
    let currentResult = await this.runTest(testFilePath);

    for (let i = 1; i <= this.maxFixAttempts; i++) {
      console.log(`\n🔧 Fix attempt ${i}/${this.maxFixAttempts}`);

      if (currentResult.success) {
        console.log(`✅ Test passed successfully!`);
        break;
      }

      // Генерируем исправление
      const fixedCode = await this.generateFix(
        currentCode,
        currentResult,
        originalCodePath,
      );

      // Сохраняем попытку
      const attempt: FixAttempt = {
        attemptNumber: i,
        originalCode: currentCode,
        fixedCode: fixedCode,
        success: false,
      };

      // Записываем исправленный код
      await fs.writeFile(testFilePath, fixedCode, "utf-8");

      // Запускаем тест снова
      const newResult = await this.runTest(testFilePath);

      attempt.success = newResult.success;
      if (!newResult.success) {
        attempt.error = newResult.error;
      }

      attempts.push(attempt);

      if (newResult.success) {
        console.log(`✅ Test fixed successfully in attempt ${i}!`);
        break;
      }

      currentCode = fixedCode;
      currentResult = newResult;

      if (i === this.maxFixAttempts) {
        console.log(
          `❌ Failed to fix test after ${this.maxFixAttempts} attempts`,
        );
      }
    }

    return attempts;
  }

  private async generateFix(
    testCode: string,
    result: TestResult,
    originalCodePath?: string,
  ): Promise<string> {
    console.log(
      `   🤖 Generating fix for ${result.failedTests.length} failed test(s)`,
    );

    // Формируем информацию о failed тестах
    const failedTestsInfo = result.failedTests
      .map(
        (test) => `
Test: ${test.name}
Error: ${test.error}
Stack trace: ${test.stackTrace || "N/A"}
    `,
      )
      .join("\n");

    // Загружаем оригинальный код компонента если указан
    let originalCode = "";
    if (originalCodePath && (await fs.pathExists(originalCodePath))) {
      originalCode = await fs.readFile(originalCodePath, "utf-8");
      originalCode = `\nОРИГИНАЛЬНЫЙ КОД КОМПОНЕНТА/УТИЛИТЫ:
\`\`\`typescript
${originalCode}
\`\`\`
`;
    }

    const prompt = `Ты — Senior QA Engineer, специализирующийся на исправлении тестов.

Твоя задача: исправить неработающие тесты, чтобы они проходили успешно.

ПРОБЛЕМНЫЙ ТЕСТ:
\`\`\`typescript
${testCode}
\`\`\`

ИНФОРМАЦИЯ О ПРОВАЛЕННЫХ ТЕСТАХ:
${failedTestsInfo}

ВЫВОД ТЕСТОВ:
${result.output.slice(0, 2000)} // Ограничиваем вывод

${originalCode}

ПРАВИЛА ИСПРАВЛЕНИЯ:
1. Не меняй логику тестов, только исправляй ошибки
2. Добавь недостающие импорты (например, '@testing-library/jest-dom')
3. Исправь неправильные селекторы (getByRole, getByText, etc.)
4. Добавь моки если необходимо
5. Убедись, что тесты соответствуют API компонента
6. Не удаляй существующие тесты, только исправляй их

ВАЖНЫЕ НАПРАВЛЕНИЯ ДЛЯ ИСПРАВЛЕНИЙ:
${this.generateFixSuggestions(result)}

Сгенерируй ИСПРАВЛЕННУЮ ВЕРСИЮ теста. Верни ТОЛЬКО код теста без комментариев.

Исправленный тест:`;

    const response = await this.ollama.generate(prompt);

    // Извлекаем код из ответа
    const fixedCode = this.extractCodeFromResponse(response);
    return fixedCode;
  }

  private generateFixSuggestions(result: TestResult): string {
    const suggestions: string[] = [];

    for (const test of result.failedTests) {
      const error = test.error.toLowerCase();

      if (error.includes("not defined") || error.includes("is not defined")) {
        suggestions.push(
          `- ${test.name}: Добавить недостающий импорт для ${error.match(/'([^']+)'/)?.[1] || "неизвестного модуля"}`,
        );
      }

      if (
        error.includes("toBeInTheDocument") ||
        error.includes("toBeDisabled")
      ) {
        suggestions.push(
          `- ${test.name}: Добавить импорт '@testing-library/jest-dom'`,
        );
      }

      if (error.includes("Unable to find an element")) {
        suggestions.push(
          `- ${test.name}: Исправить селектор элемента. Проверить role, text или testId`,
        );
      }

      if (error.includes("received value must be a mock")) {
        suggestions.push(`- ${test.name}: Добавить jest.fn() для мока функции`);
      }

      if (error.includes("timeout") || error.includes("async")) {
        suggestions.push(
          `- ${test.name}: Добавить async/await или увеличить таймаут`,
        );
      }

      if (error.includes("Cannot read properties of undefined")) {
        suggestions.push(
          `- ${test.name}: Добавить проверку на undefined/null или мокнуть данные`,
        );
      }
    }

    return suggestions.length > 0
      ? suggestions.join("\n")
      : "- Исправить синтаксические ошибки и убедиться в корректности импортов";
  }

  private parseFailedTests(output: string, filePath: string): FailedTest[] {
    const failedTests: FailedTest[] = [];

    // Регулярное выражение для парсинга failed тестов из Jest вывода
    const testPattern = /●\s+(.*?)\n\s+(.*?)\n(?:\s+at\s+(.*?)\n)?/gs;
    let match;

    while ((match = testPattern.exec(output)) !== null) {
      failedTests.push({
        name: match[1].trim(),
        error: match[2].trim(),
        stackTrace: match[3]?.trim(),
        filePath,
      });
    }

    // Если не нашли по первому паттерну, пробуем другой
    if (failedTests.length === 0) {
      const simplePattern = /✕\s+(.*?)\s+\(.*?\)\n\s+(.*?)\n/gs;
      while ((match = simplePattern.exec(output)) !== null) {
        failedTests.push({
          name: match[1].trim(),
          error: match[2].trim(),
          stackTrace: undefined,
          filePath,
        });
      }
    }

    return failedTests;
  }

  private extractCodeFromResponse(response: string): string {
    // Извлекаем код из маркдаун блока
    const codeBlockRegex =
      /```(?:tsx|jsx|typescript|javascript|react)?\n([\s\S]*?)```/;
    const match = response.match(codeBlockRegex);

    if (match && match[1]) {
      return match[1].trim();
    }

    // Если нет блоков кода, пробуем найти describe или it
    const testBlockRegex = /(import.*?[\s\S]*?describe\([\s\S]*?\);?)/;
    const testMatch = response.match(testBlockRegex);

    if (testMatch) {
      return testMatch[1].trim();
    }

    return response.trim();
  }

  async runAllTests(testDir: string): Promise<Map<string, TestResult>> {
    const results = new Map<string, TestResult>();
    const testFiles = await this.findTestFiles(testDir);

    console.log(`\n🔍 Found ${testFiles.length} test files`);

    for (const testFile of testFiles) {
      const result = await this.runTest(testFile);
      results.set(testFile, result);
    }

    return results;
  }

  async runAndFixAllTests(
    testDir: string,
    sourceDir?: string,
  ): Promise<Map<string, FixAttempt[]>> {
    const allFixes = new Map<string, FixAttempt[]>();
    const testFiles = await this.findTestFiles(testDir);

    console.log(`\n🔍 Found ${testFiles.length} test files to fix`);

    for (const testFile of testFiles) {
      // Пытаемся найти исходный файл компонента
      let sourceFile = "";
      if (sourceDir) {
        const baseName = path
          .basename(testFile)
          .replace(".test.ts", "")
          .replace(".test.tsx", "");
        const possibleExtensions = [".tsx", ".ts", ".jsx", ".js"];

        for (const ext of possibleExtensions) {
          const candidate = path.join(sourceDir, `${baseName}${ext}`);
          if (await fs.pathExists(candidate)) {
            sourceFile = candidate;
            break;
          }
        }
      }

      const fixes = await this.runAndFix(testFile, sourceFile || undefined);
      allFixes.set(testFile, fixes);
    }

    return allFixes;
  }

  private async findTestFiles(testDir: string): Promise<string[]> {
    const { glob } = await import("glob");
    const patterns = [
      `${testDir}/**/*.test.ts`,
      `${testDir}/**/*.test.tsx`,
      `${testDir}/**/*.test.js`,
      `${testDir}/**/*.test.jsx`,
      `${testDir}/**/__tests__/**/*.ts`,
      `${testDir}/**/__tests__/**/*.tsx`,
    ];

    const files = await glob(patterns, {
      absolute: true,
      nodir: true,
    });

    return files;
  }

  generateReport(results: Map<string, TestResult>): string {
    let report = "\n╔════════════════════════════════════════════════╗\n";
    report += "║           TEST RUN REPORT                      ║\n";
    report += "╚════════════════════════════════════════════════╝\n\n";

    let passed = 0;
    let failed = 0;
    let totalDuration = 0;

    for (const [file, result] of results) {
      const fileName = path.basename(file);
      const status = result.success ? "✅ PASS" : "❌ FAIL";
      report += `${status} ${fileName} (${result.duration}ms)\n`;

      if (!result.success) {
        report += `   Errors:\n`;
        for (const test of result.failedTests) {
          report += `     - ${test.name}\n`;
          report += `       ${test.error.slice(0, 100)}...\n`;
        }
      }

      if (result.success) passed++;
      else failed++;
      totalDuration += result.duration;
    }

    report += `\n📊 Summary:\n`;
    report += `   Total: ${results.size} tests\n`;
    report += `   Passed: ${passed}\n`;
    report += `   Failed: ${failed}\n`;
    report += `   Success rate: ${((passed / results.size) * 100).toFixed(2)}%\n`;
    report += `   Total duration: ${totalDuration}ms\n`;

    return report;
  }

  async generateFixReport(fixes: Map<string, FixAttempt[]>): Promise<string> {
    let report = "\n╔════════════════════════════════════════════════╗\n";
    report += "║           TEST FIX REPORT                    ║\n";
    report += "╚════════════════════════════════════════════════╝\n\n";

    for (const [file, attempts] of fixes) {
      const fileName = path.basename(file);
      const lastAttempt = attempts[attempts.length - 1];

      if (lastAttempt.success) {
        report += `✅ ${fileName} - Fixed after ${attempts.length} attempt(s)\n`;
      } else {
        report += `❌ ${fileName} - Failed to fix after ${attempts.length} attempt(s)\n`;
      }

      for (const attempt of attempts) {
        const status = attempt.success ? "✅" : "❌";
        report += `   ${status} Attempt ${attempt.attemptNumber}: ${attempt.success ? "SUCCESS" : "FAILED"}\n`;
        if (attempt.error && !attempt.success) {
          report += `      Error: ${attempt.error.slice(0, 100)}...\n`;
        }
      }
      report += "\n";
    }

    return report;
  }
}
