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
  private testCache: Map<
    string,
    { success: boolean; timestamp: number; testPath: string }
  > = new Map();
  private cacheFile: string = ".test-cache.json";

  constructor(model: string = "qwen2.5-coder:7b", maxFixAttempts: number = 3) {
    this.ollama = new OllamaClient(model);
    this.maxFixAttempts = maxFixAttempts;
    this.loadCache();
  }

  // Загрузка кэша из файла
  private loadCache(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const cache = fs.readJsonSync(this.cacheFile);
        Object.entries(cache).forEach(([key, value]: [string, any]) => {
          this.testCache.set(key, value);
        });
        console.log(`📦 Loaded test cache with ${this.testCache.size} entries`);
      }
    } catch (error) {
      console.log("No existing test cache found");
    }
  }

  // Сохранение кэша в файл
  private saveCache(): void {
    try {
      const cache = Object.fromEntries(this.testCache);
      fs.writeJsonSync(this.cacheFile, cache, { spaces: 2 });
    } catch (error) {
      console.error("Failed to save test cache:", error);
    }
  }

  // Проверка, нужно ли запускать тест
  public shouldRunTest(testFilePath: string, force: boolean = false): boolean {
    if (force) return true;

    const cached = this.testCache.get(testFilePath);
    if (!cached) return true;

    // Проверяем время последнего успешного прохода (24 часа)
    const oneDay = 24 * 60 * 60 * 1000;
    const isRecent = Date.now() - cached.timestamp < oneDay;

    return !(cached.success && isRecent);
  }

  // Проверка, существует ли тест и проходит ли он
  public async isTestPassing(
    testFilePath: string,
    forceCheck: boolean = false,
  ): Promise<boolean> {
    // Проверяем кэш
    if (!forceCheck) {
      const cached = this.testCache.get(testFilePath);
      if (cached && cached.success) {
        const oneDay = 24 * 60 * 60 * 1000;
        const isRecent = Date.now() - cached.timestamp < oneDay;
        if (isRecent) {
          return true;
        }
      }
    }

    // Если тест не существует, возвращаем false
    if (!(await fs.pathExists(testFilePath))) {
      return false;
    }

    // Запускаем тест для проверки
    const result = await this.runTest(testFilePath, true);
    return result.success;
  }

  async runTest(
    testFilePath: string,
    force: boolean = false,
  ): Promise<TestResult> {
    // Проверяем кэш
    if (!force && !this.shouldRunTest(testFilePath, false)) {
      const cached = this.testCache.get(testFilePath);
      if (cached && cached.success) {
        console.log(
          `   ⏭️  Skipping test (passed recently): ${path.basename(testFilePath)}`,
        );
        return {
          success: true,
          output: "Cached test result - test passed previously",
          duration: 0,
          failedTests: [],
        };
      }
    }

    // Проверяем существование тестового файла
    if (!(await fs.pathExists(testFilePath))) {
      const result: TestResult = {
        success: false,
        output: "",
        error: `Test file not found: ${testFilePath}`,
        failedTests: [],
        duration: 0,
      };
      return result;
    }

    console.log(`   🧪 Running test: ${path.basename(testFilePath)}`);

    const startTime = Date.now();

    try {
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

      // Сохраняем в кэш
      this.testCache.set(testFilePath, {
        success: true,
        timestamp: Date.now(),
        testPath: testFilePath,
      });
      this.saveCache();

      console.log(`   ✅ Test passed in ${duration}ms`);
      this.testResults.set(testFilePath, result);
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;

      const failedTests = this.parseFailedTests(
        error.stdout || error.stderr,
        testFilePath,
      );

      const result: TestResult = {
        success: false,
        output: error.stdout || "",
        error: error.stderr || error.message,
        failedTests,
        duration,
      };

      // Сохраняем провал в кэш
      this.testCache.set(testFilePath, {
        success: false,
        timestamp: Date.now(),
        testPath: testFilePath,
      });
      this.saveCache();

      console.log(
        `   ❌ Test failed in ${duration}ms. ${failedTests.length} test(s) failed`,
      );
      this.testResults.set(testFilePath, result);
      return result;
    }
  }

  async runAndFix(
    testFilePath: string,
    originalCodePath?: string,
    force: boolean = false,
  ): Promise<FixAttempt[]> {
    // Проверяем, нужно ли запускать тест
    if (!force && (await this.isTestPassing(testFilePath, false))) {
      console.log(
        `   ⏭️  Test already passing, skipping fix: ${path.basename(testFilePath)}`,
      );
      return [];
    }

    const attempts: FixAttempt[] = [];
    let currentCode = await fs.readFile(testFilePath, "utf-8");
    let currentResult = await this.runTest(testFilePath, true);

    for (let i = 1; i <= this.maxFixAttempts; i++) {
      console.log(`   🔧 Fix attempt ${i}/${this.maxFixAttempts}`);

      if (currentResult.success) {
        console.log(`   ✅ Test passed successfully!`);
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
      const newResult = await this.runTest(testFilePath, true);

      attempt.success = newResult.success;
      if (!newResult.success) {
        attempt.error = newResult.error;
      }

      attempts.push(attempt);

      if (newResult.success) {
        console.log(`   ✅ Test fixed successfully in attempt ${i}!`);
        // Обновляем кэш с успешным результатом
        this.testCache.set(testFilePath, {
          success: true,
          timestamp: Date.now(),
          testPath: testFilePath,
        });
        this.saveCache();
        break;
      }

      currentCode = fixedCode;
      currentResult = newResult;

      if (i === this.maxFixAttempts) {
        console.log(
          `   ❌ Failed to fix test after ${this.maxFixAttempts} attempts`,
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
${result.output.slice(0, 2000)}

${originalCode}

ПРАВИЛА ИСПРАВЛЕНИЯ:
1. Не меняй логику тестов, только исправляй ошибки
2. Добавь недостающие импорты (например, '@testing-library/jest-dom')
3. Исправь неправильные селекторы (getByRole, getByText, etc.)
4. Добавь моки если необходимо
5. Убедись, что тесты соответствуют API компонента

Сгенерируй ИСПРАВЛЕННУЮ ВЕРСИЮ теста. Верни ТОЛЬКО код теста без комментариев.

Исправленный тест:`;

    const response = await this.ollama.generate(prompt);
    const fixedCode = this.extractCodeFromResponse(response);
    return fixedCode;
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

  async runAllTests(
    testDir: string,
    force: boolean = false,
  ): Promise<Map<string, TestResult>> {
    const results = new Map<string, TestResult>();
    const testFiles = await this.findTestFiles(testDir);

    console.log(`\n🔍 Found ${testFiles.length} test files`);

    for (const testFile of testFiles) {
      const result = await this.runTest(testFile, force);
      results.set(testFile, result);
    }

    return results;
  }

  async runAndFixAllTests(
    testDir: string,
    sourceDir?: string,
    force: boolean = false,
  ): Promise<Map<string, FixAttempt[]>> {
    const allFixes = new Map<string, FixAttempt[]>();
    const testFiles = await this.findTestFiles(testDir);

    console.log(`\n🔍 Found ${testFiles.length} test files to check`);

    let skipped = 0;
    let toFix = 0;

    for (const testFile of testFiles) {
      if (!force && (await this.isTestPassing(testFile, false))) {
        console.log(`   ⏭️  Skipping passing test: ${path.basename(testFile)}`);
        skipped++;
        continue;
      }

      toFix++;

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

      const fixes = await this.runAndFix(
        testFile,
        sourceFile || undefined,
        true,
      );
      if (fixes.length > 0) {
        allFixes.set(testFile, fixes);
      }
    }

    console.log(
      `\n📊 Summary: ${skipped} passing tests skipped, ${toFix} tests needed fixing`,
    );

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
      ignore: ["**/*.backup.*"],
    });

    return files;
  }

  // Очистка кэша
  public clearCache(): void {
    this.testCache.clear();
    this.saveCache();
    console.log("🧹 Test cache cleared");
  }

  // Вывод статистики кэша
  public getCacheStats(): { total: number; passed: number; failed: number } {
    let passed = 0;
    let failed = 0;

    this.testCache.forEach((value) => {
      if (value.success) passed++;
      else failed++;
    });

    return {
      total: this.testCache.size,
      passed,
      failed,
    };
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

    let fixed = 0;
    let failed = 0;

    for (const [file, attempts] of fixes) {
      const fileName = path.basename(file);
      const lastAttempt = attempts[attempts.length - 1];

      if (lastAttempt.success) {
        report += `✅ ${fileName} - Fixed after ${attempts.length} attempt(s)\n`;
        fixed++;
      } else {
        report += `❌ ${fileName} - Failed to fix after ${attempts.length} attempt(s)\n`;
        failed++;
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

    report += `📊 Fix Summary:\n`;
    report += `   Fixed: ${fixed}\n`;
    report += `   Failed to fix: ${failed}\n`;
    report += `   Success rate: ${((fixed / (fixed + failed)) * 100).toFixed(2)}%\n`;

    return report;
  }
}
