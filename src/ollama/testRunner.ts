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
    {
      success: boolean;
      timestamp: number;
      testPath: string;
      testPlacement?: string;
    }
  > = new Map();
  private cacheFile: string = ".test-cache.json";
  private testPlacement: "separate" | "adjacent";

  constructor(
    model: string = "qwen2.5-coder:7b",
    maxFixAttempts: number = 3,
    testPlacement: "separate" | "adjacent" = "separate",
  ) {
    this.ollama = new OllamaClient(model);
    this.maxFixAttempts = maxFixAttempts;
    this.testPlacement = testPlacement;
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

  // Получение ключа кэша на основе пути к тесту и стратегии размещения
  private getCacheKey(testFilePath: string): string {
    // Используем абсолютный путь и стратегию размещения как часть ключа
    const absolutePath = path.resolve(testFilePath);
    return `${absolutePath}|${this.testPlacement}`;
  }

  // Проверка, нужно ли запускать тест
  public shouldRunTest(testFilePath: string, force: boolean = false): boolean {
    if (force) return true;

    const cacheKey = this.getCacheKey(testFilePath);
    const cached = this.testCache.get(cacheKey);

    if (!cached) return true;

    // Проверяем время последнего успешного прохода (24 часа)
    const oneDay = 24 * 60 * 60 * 1000;
    const isRecent = Date.now() - cached.timestamp < oneDay;

    // Также проверяем, соответствует ли стратегия размещения
    const placementMatch = cached.testPlacement === this.testPlacement;

    return !(cached.success && isRecent && placementMatch);
  }

  // Проверка, существует ли тест и проходит ли он
  public async isTestPassing(
    testFilePath: string,
    forceCheck: boolean = false,
  ): Promise<boolean> {
    // Проверяем кэш
    if (!forceCheck) {
      const cacheKey = this.getCacheKey(testFilePath);
      const cached = this.testCache.get(cacheKey);

      if (cached && cached.success) {
        const oneDay = 24 * 60 * 60 * 1000;
        const isRecent = Date.now() - cached.timestamp < oneDay;
        const placementMatch = cached.testPlacement === this.testPlacement;

        if (isRecent && placementMatch) {
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
    const cacheKey = this.getCacheKey(testFilePath);

    // Проверяем кэш
    if (!force && !this.shouldRunTest(testFilePath, false)) {
      const cached = this.testCache.get(cacheKey);
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
        `npx vitest run "${testFilePath}" --reporter=verbose`,
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

      // Сохраняем в кэш с учетом стратегии размещения
      this.testCache.set(cacheKey, {
        success: true,
        timestamp: Date.now(),
        testPath: testFilePath,
        testPlacement: this.testPlacement,
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

      // Сохраняем провал в кэш с учетом стратегии размещения
      this.testCache.set(cacheKey, {
        success: false,
        timestamp: Date.now(),
        testPath: testFilePath,
        testPlacement: this.testPlacement,
      });
      this.saveCache();

      console.log(
        `   ❌ Test failed in ${duration}ms. ${failedTests.length} test(s) failed`,
      );
      this.testResults.set(testFilePath, result);
      return result;
    }
  }

  private parseFailedTests(output: string, filePath: string): FailedTest[] {
    const failedTests: FailedTest[] = [];

    // Парсинг для Vitest
    const testPattern = /❯\s+(.*?)\n\s+×\s+(.*?)\n\s+→\s+(.*?)\n/gs;
    let match;

    while ((match = testPattern.exec(output)) !== null) {
      failedTests.push({
        name: match[2].trim(),
        error: match[3].trim(),
        stackTrace: match[1].trim(),
        filePath,
      });
    }

    // Альтернативный парсинг
    if (failedTests.length === 0) {
      const simplePattern = /FAIL\s+.*?\n\s+(.*?)\n\s+Error:\s+(.*?)\n/gs;
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
        const cacheKey = this.getCacheKey(testFilePath);
        this.testCache.set(cacheKey, {
          success: true,
          timestamp: Date.now(),
          testPath: testFilePath,
          testPlacement: this.testPlacement,
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
      originalCode = `\nОРИГИНАЛЬНЫЙ КОД:\n\`\`\`typescript\n${originalCode}\n\`\`\`\n`;
    }

    const prompt = `Ты — Senior QA Engineer, специализирующийся на исправлении тестов для Vitest.

Твоя задача: исправить неработающие тесты.

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
1. Используй синтаксис Vitest (vi вместо jest)
2. Добавь импорт: import { describe, it, expect, vi } from 'vitest'
3. Добавь import '@testing-library/jest-dom/vitest'
4. Замени jest.fn() на vi.fn()
5. Замени jest.mock на vi.mock

Сгенерируй ИСПРАВЛЕННУЮ ВЕРСИЮ теста.

Исправленный тест:`;

    const response = await this.ollama.generate(prompt);
    return this.extractCodeFromResponse(response);
  }

  private extractCodeFromResponse(response: string): string {
    const codeBlockRegex =
      /```(?:tsx|jsx|typescript|javascript|react)?\n([\s\S]*?)```/;
    const match = response.match(codeBlockRegex);

    if (match && match[1]) {
      return match[1].trim();
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
        // Определяем возможные имена исходных файлов в зависимости от стратегии размещения
        const testFileName = path.basename(testFile);
        const baseName = testFileName
          .replace(".test.ts", "")
          .replace(".test.tsx", "");

        const possibleExtensions = [".tsx", ".ts", ".jsx", ".js"];

        for (const ext of possibleExtensions) {
          let candidate: string;

          if (this.testPlacement === "adjacent") {
            // При adjacent стратегии тест рядом с исходным файлом
            candidate = testFile.replace(/\.test\.(tsx|ts)$/, ext);
          } else {
            // При separate стратегии нужно подняться на уровень выше из __tests__
            const testDir = path.dirname(testFile);
            const parentDir = path.dirname(testDir);
            candidate = path.join(parentDir, `${baseName}${ext}`);
          }

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

    let patterns: string[];

    if (this.testPlacement === "adjacent") {
      // При adjacent стратегии ищем тесты рядом с исходными файлами
      patterns = [`${testDir}/**/*.test.ts`, `${testDir}/**/*.test.tsx`];
    } else {
      // При separate стратегии ищем тесты в папках __tests__
      patterns = [
        `${testDir}/**/__tests__/**/*.test.ts`,
        `${testDir}/**/__tests__/**/*.test.tsx`,
        `${testDir}/**/*.test.ts`,
        `${testDir}/**/*.test.tsx`,
      ];
    }

    const files = await glob(patterns, {
      absolute: true,
      nodir: true,
      ignore: ["**/*.backup.*", "**/node_modules/**"],
    });

    return files;
  }

  // Очистка кэша
  public clearCache(): void {
    this.testCache.clear();
    this.saveCache();
    console.log("🧹 Test cache cleared");
  }

  // Очистка кэша для конкретной стратегии
  public clearCacheForPlacement(placement: "separate" | "adjacent"): void {
    const toDelete: string[] = [];

    this.testCache.forEach((value, key) => {
      if (value.testPlacement === placement) {
        toDelete.push(key);
      }
    });

    toDelete.forEach((key) => this.testCache.delete(key));
    this.saveCache();
    console.log(
      `🧹 Cleared cache for ${placement} placement strategy (${toDelete.length} entries)`,
    );
  }

  // Вывод статистики кэша
  public getCacheStats(): {
    total: number;
    passed: number;
    failed: number;
    byPlacement: Record<string, { passed: number; failed: number }>;
  } {
    let passed = 0;
    let failed = 0;
    const byPlacement: Record<string, { passed: number; failed: number }> = {
      separate: { passed: 0, failed: 0 },
      adjacent: { passed: 0, failed: 0 },
    };

    this.testCache.forEach((value) => {
      if (value.success) {
        passed++;
        if (value.testPlacement) {
          byPlacement[value.testPlacement].passed++;
        }
      } else {
        failed++;
        if (value.testPlacement) {
          byPlacement[value.testPlacement].failed++;
        }
      }
    });

    return {
      total: this.testCache.size,
      passed,
      failed,
      byPlacement,
    };
  }

  generateReport(results: Map<string, TestResult>): string {
    let report = "\n╔════════════════════════════════════════════════╗\n";
    report += "║           TEST RUN REPORT (Vitest)              ║\n";
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
    report += `   Test placement: ${this.testPlacement === "adjacent" ? "adjacent (next to source)" : "separate (__tests__ folder)"}\n`;

    return report;
  }

  async generateFixReport(fixes: Map<string, FixAttempt[]>): Promise<string> {
    let report = "\n╔════════════════════════════════════════════════╗\n";
    report += "║           TEST FIX REPORT (Vitest)             ║\n";
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
    }

    report += `\n📊 Fix Summary:\n`;
    report += `   Fixed: ${fixed}\n`;
    report += `   Failed to fix: ${failed}\n`;
    report += `   Success rate: ${((fixed / (fixed + failed)) * 100).toFixed(2)}%\n`;

    return report;
  }
}
