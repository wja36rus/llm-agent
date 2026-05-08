import * as fs from 'fs-extra';
import * as path from 'path';

import { ComponentAnalyzer, FunctionInfo } from './ollama/analyzer';
import { OllamaClient } from './ollama/ollamaClient';
import { PromptGenerator } from './ollama/promptGenerator';
import { TestRunner } from './ollama/testRunner';
import { TestValidator } from './ollama/testValidator';

interface Config {
  componentsDir: string;
  outputDir: string;
  model: string;
  extensions: string[];
  excludePatterns?: string[];
  autoFix?: boolean;
  maxFixAttempts?: number;
  skipPassingTests?: boolean;
  forceGenerate?: boolean;
  testPlacement?: 'separate' | 'adjacent'; // Новая опция: separate (в __tests__) или adjacent (рядом)
  validateTests?: boolean;
}

class TestGenerator {
  private analyzer: ComponentAnalyzer;
  private ollama: OllamaClient;
  private promptGenerator: PromptGenerator;
  private config: Config;
  private generatedTestsCount: number = 0;
  private failedGenerations: string[] = [];
  private skippedTests: string[] = [];
  private testRunner: TestRunner | null = null;
  private validator: TestValidator;

  constructor(config: Config) {
    this.analyzer = new ComponentAnalyzer();
    this.ollama = new OllamaClient(config.model);
    this.promptGenerator = new PromptGenerator();
    this.validator = new TestValidator();

    this.config = {
      ...config,
      testPlacement: config.testPlacement || 'separate', // По умолчанию отдельная папка
      validateTests: config.validateTests !== undefined ? config.validateTests : true,
      excludePatterns: config.excludePatterns || [
        '**/*.test.*',
        '**/*.spec.*',
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/.git/**',
        '**/__tests__/**',
        '**/examples/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/setupTests.*',
        '**/reportWebVitals.*',
        '**/index.*',
        '**/main.*',
      ],
    };
    if (config.skipPassingTests || config.autoFix) {
      this.testRunner = new TestRunner(
        config.model,
        config.maxFixAttempts || 3,
        config.testPlacement || 'separate', // Передаем стратегию размещения
      );
    }
  }

  // Проверка, является ли файл частью генератора тестов
  private isGeneratorFile(filePath: string): boolean {
    const fileName = path.basename(filePath);
    const generatorFiles = [
      'analyzer.ts',
      'analyzer.js',
      'ollamaClient.ts',
      'ollamaClient.js',
      'promptGenerator.ts',
      'promptGenerator.js',
      'testRunner.ts',
      'testRunner.js',
      'index.ts',
      'index.js',
      'config.ts',
      'config.js',
    ];

    if (generatorFiles.includes(fileName)) {
      return true;
    }

    const normalizedPath = filePath.replace(/\\/g, '/');
    if (
      normalizedPath.includes('/test-generator/') ||
      normalizedPath.includes('/tools/') ||
      normalizedPath.includes('/scripts/') ||
      normalizedPath.includes('/generator/') ||
      normalizedPath.includes('/node_modules/')
    ) {
      return true;
    }

    return false;
  }

  // Проверка, должен ли файл быть исключен по паттернам
  private isExcludedByPattern(filePath: string): boolean {
    if (!this.config.excludePatterns) return false;

    const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

    for (const pattern of this.config.excludePatterns) {
      const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.');

      const regex = new RegExp(regexPattern);
      if (regex.test(relativePath) || regex.test(filePath)) {
        return true;
      }
    }

    return false;
  }

  // Проверка, нужно ли генерировать тест
  private async shouldGenerateTest(filePath: string, funcInfo: FunctionInfo): Promise<boolean> {
    const testOutputPath = this.getTestOutputPath(filePath, funcInfo);

    if (!(await fs.pathExists(testOutputPath))) {
      return true;
    }

    if (this.config.forceGenerate) {
      console.log(`   🔄 Force mode: will regenerate test`);
      return true;
    }

    if (this.config.skipPassingTests && this.testRunner) {
      const isPassing = await this.testRunner.isTestPassing(testOutputPath, false);

      if (isPassing) {
        console.log(`   ⏭️  Skipping: test already exists and passes`);
        this.skippedTests.push(testOutputPath);
        return false;
      } else {
        console.log(`   🔄 Test exists but failing, will regenerate`);
        return true;
      }
    }

    return true;
  }

  async generateForFile(componentPath: string): Promise<void> {
    if (this.isGeneratorFile(componentPath)) {
      console.log(`⏭️  Skipping generator file: ${path.basename(componentPath)}`);
      return;
    }

    if (this.isExcludedByPattern(componentPath)) {
      console.log(`⏭️  Skipping excluded file: ${path.basename(componentPath)}`);
      return;
    }

    console.log(`\n📝 Processing: ${componentPath}`);

    try {
      const functions = await this.analyzer.analyze(componentPath);

      if (functions.length === 0) {
        console.log(`⚠️  No functions found in ${componentPath}`);
        return;
      }

      console.log(`✅ Found ${functions.length} function(s) in ${path.basename(componentPath)}`);

      for (const funcInfo of functions) {
        const generated = await this.generateTestForFunction(componentPath, funcInfo);
        if (generated) {
          this.generatedTestsCount++;
        }
      }
    } catch (error) {
      console.error(`❌ Error processing ${componentPath}:`, error);
      this.failedGenerations.push(componentPath);
    }
  }

  // src/index.ts - обновите метод generateTestForFunction

  private async generateTestForFunction(filePath: string, funcInfo: FunctionInfo): Promise<boolean> {
    const shouldGenerate = await this.shouldGenerateTest(filePath, funcInfo);
    if (!shouldGenerate) {
      return false;
    }

    const code = await fs.readFile(filePath, 'utf-8');

    const typeIcon =
      funcInfo.type === 'component' ? '⚛️' : funcInfo.type === 'hook' ? '🪝' : funcInfo.type === 'helper' ? '🔧' : '📦';

    console.log(`\n${typeIcon} Generating test for ${funcInfo.type}: ${funcInfo.name}`);
    console.log(
      `   Parameters: ${funcInfo.params.map((p) => `${p.name}${p.optional ? '?' : ''}${p.type ? ': ' + p.type : ''}`).join(', ') || 'none'}`,
    );
    console.log(`   Returns: ${funcInfo.returnType || 'unknown'}`);
    if (funcInfo.isAsync) console.log(`   Async: yes`);
    if (funcInfo.hooks.length > 0) console.log(`   Hooks: ${funcInfo.hooks.join(', ')}`);

    const prompt = this.promptGenerator.generatePrompt(funcInfo, code);
    console.log(`   🤖 Generating test with ${this.config.model}...`);
    const generatedTest = await this.ollama.generate(prompt);

    let testCode = this.extractTestCode(generatedTest);
    testCode = this.postProcessTest(testCode, funcInfo, filePath);

    if (!testCode || testCode.length < 50) {
      console.log(`   ⚠️  Generated test code is too short or empty`);
      this.failedGenerations.push(filePath);
      return false;
    }

    const outputPath = this.getTestOutputPath(filePath, funcInfo);

    // Валидация сгенерированного теста (если включена)
    if (this.config.validateTests && this.validator) {
      console.log(`   🔍 Validating generated test...`);
      const validation = await this.validator.validateTest(testCode, outputPath);

      if (!validation.isValid) {
        console.log(`   ⚠️  Test validation failed:`);
        validation.errors.forEach((err) => console.log(`      ❌ ${err}`));
        validation.warnings.forEach((warn) => console.log(`      ⚠️  ${warn}`));

        if (validation.errors.length > 0 && this.config.autoFix) {
          console.log(`   🔧 Attempting to fix validation errors...`);
          const fixedTest = await this.fixTestWithLLM(testCode, validation);
          if (fixedTest) {
            testCode = fixedTest;
            console.log(`   ✅ Test fixed after validation`);
          }
        }
      } else if (validation.warnings.length > 0) {
        console.log(`   ⚠️  Validation warnings:`);
        validation.warnings.forEach((warn) => console.log(`      ⚠️  ${warn}`));
      } else if (validation.isValid) {
        console.log(`   ✅ Test validation passed`);
      }
    }

    await this.saveTest(outputPath, testCode);
    console.log(`   ✅ Test generated: ${outputPath}`);
    return true;
  }

  private async fixTestWithLLM(testCode: string, validation: any): Promise<string | null> {
    const prompt = `Fix the following test code based on validation errors:

CURRENT CODE:
\`\`\`typescript
${testCode}
\`\`\`

ERRORS TO FIX:
${validation.errors.join('\n')}

REQUIREMENTS:
1. Add missing imports
2. Fix syntax errors
3. Ensure proper Vitest syntax (use vi instead of jest)
4. Add necessary matchers imports

Return ONLY the fixed test code.`;

    try {
      const fixed = await this.ollama.generate(prompt);
      return this.extractTestCode(fixed);
    } catch (error) {
      return null;
    }
  }

  async generateForDirectory(): Promise<void> {
    const files = await this.findAllSourceFiles();

    console.log(`\n🔍 Found ${files.length} source files in ${this.config.componentsDir}`);

    const filteredFiles = files.filter((file) => {
      if (this.isGeneratorFile(file)) return false;
      if (this.isExcludedByPattern(file)) return false;
      return true;
    });

    console.log(`📝 Will process ${filteredFiles.length} files for test generation`);

    if (this.config.skipPassingTests) {
      console.log(`✨ Skip passing tests mode: enabled`);
    }
    if (this.config.forceGenerate) {
      console.log(`🔄 Force regenerate mode: enabled`);
    }

    // Показываем стратегию размещения тестов
    const placementStrategy =
      this.config.testPlacement === 'adjacent'
        ? '📁 Test placement: adjacent (next to source files)'
        : '📁 Test placement: separate (in __tests__ folders)';
    console.log(placementStrategy);

    if (filteredFiles.length === 0) {
      console.log(`⚠️  No valid files found to process`);
      return;
    }

    for (const file of filteredFiles) {
      await this.generateForFile(file);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 GENERATION SUMMARY`);
    console.log(`${'='.repeat(60)}`);
    console.log(`✅ Tests generated: ${this.generatedTestsCount}`);
    console.log(`⏭️  Tests skipped: ${this.skippedTests.length}`);
    console.log(`❌ Failed: ${this.failedGenerations.length}`);

    if (this.skippedTests.length > 0) {
      console.log(`\n⏭️  Skipped tests (already passing):`);
      this.skippedTests.slice(0, 5).forEach((file) => console.log(`  - ${path.basename(file)}`));
      if (this.skippedTests.length > 5) {
        console.log(`  ... and ${this.skippedTests.length - 5} more`);
      }
    }

    if (this.failedGenerations.length > 0) {
      console.log(`\n❌ Failed files:`);
      this.failedGenerations.forEach((file) => console.log(`  - ${file}`));
    }

    if (this.config.autoFix && this.testRunner) {
      console.log(`\n🚀 Auto-fix mode enabled, running tests...`);
      const outputDir =
        this.config.testPlacement === 'adjacent'
          ? this.config.componentsDir // При adjacent стратегии тесты в той же папке
          : this.config.outputDir; // При separate стратегии тесты в outputDir

      if (await fs.pathExists(outputDir)) {
        const fixes = await this.testRunner.runAndFixAllTests(
          outputDir,
          this.config.componentsDir,
          this.config.forceGenerate,
        );
        console.log(await this.testRunner.generateFixReport(fixes));
      }
    }
  }

  private async findAllSourceFiles(): Promise<string[]> {
    const { glob } = await import('glob');
    const patterns = this.config.extensions.map((ext) => `${this.config.componentsDir}/**/*.${ext}`);

    try {
      const files = await glob(patterns, {
        ignore: this.config.excludePatterns,
        absolute: true,
        nodir: true,
        follow: false,
      });
      return files.sort();
    } catch (error) {
      console.error('Error finding source files:', error);
      return [];
    }
  }

  private extractTestCode(generatedText: string): string {
    const codeBlockRegex = /```(?:tsx|jsx|typescript|javascript|react)?\n([\s\S]*?)```/;
    const match = generatedText.match(codeBlockRegex);

    if (match && match[1]) {
      let code = match[1].trim();
      code = this.cleanTestCode(code);
      return code;
    }

    const testBlockRegex = /(describe\([\s\S]*?\);?)/;
    const testMatch = generatedText.match(testBlockRegex);

    if (testMatch) {
      let code = testMatch[1].trim();
      code = this.cleanTestCode(code);
      return code;
    }

    return this.cleanTestCode(generatedText.trim());
  }

  private cleanTestCode(code: string): string {
    let cleaned = code.replace(/\/\/\s*Explanation:.*$/gm, '');
    cleaned = cleaned.replace(/\/\*\*[\s\S]*?\*\//g, '');
    cleaned = cleaned.trim();
    return cleaned;
  }

  private postProcessTest(testCode: string, funcInfo: FunctionInfo, originalFilePath: string): string {
    let processed = testCode;

    const relativePath = this.getRelativeImportPath(originalFilePath, funcInfo);

    if (funcInfo.type === 'component') {
      // Добавляем импорт для Vitest
      if (!processed.includes('from "vitest"') && !processed.includes("from 'vitest'")) {
        const vitestImport = `import { describe, it, expect, vi } from 'vitest';\n`;
        processed = vitestImport + processed;
      }

      if (!processed.includes('@testing-library/jest-dom')) {
        const jestDomImport = `import '@testing-library/jest-dom/vitest';\n`;
        if (processed.includes('from "@testing-library/react"')) {
          processed = processed.replace(/(import.*from '@testing-library\/react'.*\n)/, `$1${jestDomImport}`);
        } else {
          processed = jestDomImport + processed;
        }
      }

      if (!processed.includes('import React') && !processed.includes('import { React')) {
        const reactImport = `import React from 'react';\n`;
        processed = reactImport + processed;
      }

      // Исправляем путь импорта компонента
      processed = processed.replace(
        /import\s+{\s*(\w+)\s+}\s+from\s+['"][./]*(\w+)['"]/,
        `import { $1 } from '${relativePath}'`,
      );

      // Заменяем jest на vi
      processed = processed.replace(/jest\.fn\(\)/g, 'vi.fn()');
      processed = processed.replace(/jest\./g, 'vi.');
    } else {
      // Для утилит
      if (!processed.includes('from "vitest"') && !processed.includes("from 'vitest'")) {
        const vitestImport = `import { describe, it, expect } from 'vitest';\n\n`;
        processed = vitestImport + processed;
      }

      if (!processed.includes(`import { ${funcInfo.name} } from`)) {
        const utilityImport = `import { ${funcInfo.name} } from '${relativePath}';\n\n`;
        processed = utilityImport + processed;
      } else {
        processed = processed.replace(
          /import\s+{\s*(\w+)\s+}\s+from\s+['"][./]*(\w+)['"]/,
          `import { $1 } from '${relativePath}'`,
        );
      }
    }

    if (funcInfo.isAsync && !processed.includes('async')) {
      processed = processed.replace(/it\(/g, 'it(async ');
    }

    return processed;
  }

  private getRelativeImportPath(originalFilePath: string, funcInfo: FunctionInfo): string {
    const testOutputPath = this.getTestOutputPath(originalFilePath, funcInfo);
    const testDir = path.dirname(testOutputPath);
    const originalDir = path.dirname(originalFilePath);

    let relativePath = path.relative(testDir, originalFilePath);
    relativePath = relativePath.replace(/\.(tsx|ts|jsx|js)$/, '');
    relativePath = relativePath.replace(/\\/g, '/');

    if (!relativePath.startsWith('.')) {
      relativePath = './' + relativePath;
    }

    return relativePath;
  }

  /**
   * Определяет путь для сохранения теста в зависимости от стратегии размещения
   *
   * Стратегии:
   * - 'separate': создает папку __tests__ рядом с исходным файлом и кладет тест туда
   * - 'adjacent': кладет тест рядом с исходным файлом (файл.test.tsx)
   */
  private getTestOutputPath(filePath: string, funcInfo: FunctionInfo): string {
    const parsedPath = path.parse(filePath);
    const extension = funcInfo.type === 'component' ? 'tsx' : 'ts';
    const testFileName = `${parsedPath.name}.test.${extension}`;

    if (this.config.testPlacement === 'adjacent') {
      // Стратегия: тест рядом с исходным файлом
      // Пример: src/components/Button.tsx -> src/components/Button.test.tsx
      const outputPath = path.join(parsedPath.dir, testFileName);
      return outputPath;
    } else {
      // Стратегия: тест в папке __tests__
      // Пример: src/components/Button.tsx -> src/components/__tests__/Button.test.tsx
      const testsDir = path.join(parsedPath.dir, '__tests__');
      const outputPath = path.join(testsDir, testFileName);
      return outputPath;
    }
  }

  private async saveTest(filePath: string, content: string): Promise<void> {
    await fs.ensureDir(path.dirname(filePath));

    if (await fs.pathExists(filePath)) {
      console.log(`   ⚠️  Test already exists: ${filePath}`);
      const backupPath = `${filePath}.backup.${Date.now()}`;
      await fs.copy(filePath, backupPath);
      console.log(`   📋 Created backup: ${path.basename(backupPath)}`);
    }

    await fs.writeFile(filePath, content, 'utf-8');
  }
}

// CLI интерфейс
async function main() {
  const args = process.argv.slice(2);

  const config: Config = {
    componentsDir: args.find((arg) => arg.startsWith('--components='))?.split('=')[1] || './src',
    outputDir: args.find((arg) => arg.startsWith('--output='))?.split('=')[1] || './src/__tests__',
    model: args.find((arg) => arg.startsWith('--model='))?.split('=')[1] || 'qwen2.5-coder:7b',
    extensions: ['tsx', 'jsx', 'ts', 'js'],
    excludePatterns:
      args
        .find((arg) => arg.startsWith('--exclude='))
        ?.split('=')[1]
        ?.split(',') || undefined,
    autoFix: args.includes('--auto-fix'),
    maxFixAttempts: parseInt(args.find((arg) => arg.startsWith('--max-attempts='))?.split('=')[1] || '3'),
    skipPassingTests: args.includes('--skip-passing'),
    forceGenerate: args.includes('--force'),
    testPlacement: args.includes('--adjacent') ? 'adjacent' : 'separate',
  };

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║      AI Test Generator for React & Utilities             ║
║      Using Ollama locally                                ║
╚═══════════════════════════════════════════════════════════╝
  
Configuration:
  Source directory: ${config.componentsDir}
  Output directory: ${config.outputDir}
  Model: ${config.model}
  Extensions: ${config.extensions.join(', ')}
  Exclude patterns: ${config.excludePatterns?.join(', ') || 'default'}
  Auto-fix: ${config.autoFix ? 'enabled' : 'disabled'}
  Skip passing tests: ${config.skipPassingTests ? 'enabled' : 'disabled'}
  Force generate: ${config.forceGenerate ? 'enabled' : 'disabled'}
  Test placement: ${config.testPlacement === 'adjacent' ? 'adjacent (next to source)' : 'separate (__tests__ folder)'}
  Max fix attempts: ${config.maxFixAttempts}
  `);

  const generator = new TestGenerator(config);
  const command = args[0] || 'all';

  switch (command) {
    case 'file':
      const filePath = args[1];
      if (!filePath) {
        console.error('Please specify file path: npm run generate file src/components/Button.tsx');
        process.exit(1);
      }
      await generator.generateForFile(filePath);
      break;

    case 'list-models':
      const ollama = new OllamaClient();
      const models = await ollama.listModels();
      console.log('Available models:', models);
      break;

    case 'test':
      const testPath = args[1] || './src';
      const runner = new TestRunner(
        config.model,
        config.maxFixAttempts,
        config.testPlacement || 'separate', // Передаем стратегию
      );
      const forceTest = args.includes('--force');
      const results = await runner.runAllTests(testPath, forceTest);
      console.log(runner.generateReport(results));
      break;

    case 'fix':
      const fixPath = args[1] || './src';
      const sourcePath = args[2] || './src';
      const fixRunner = new TestRunner(config.model, config.maxFixAttempts);
      const forceFix = args.includes('--force');
      const fixes = await fixRunner.runAndFixAllTests(fixPath, sourcePath, forceFix);
      console.log(await fixRunner.generateFixReport(fixes));
      break;

    case 'fix-file':
      const testFileToFix = args[1];
      if (!testFileToFix) {
        console.error('Please specify test file path: npm run fix-file src/components/Button.test.tsx');
        process.exit(1);
      }
      const sourceFileForFix = args[2] || './src';
      const fileRunner = new TestRunner(config.model, config.maxFixAttempts);
      const forceFixFile = args.includes('--force');
      const fileFixes = await fileRunner.runAndFix(testFileToFix, sourceFileForFix, forceFixFile);
      console.log(await fileRunner.generateFixReport(new Map([[testFileToFix, fileFixes]])));
      break;

    case 'cache-stats':
      const cacheRunner = new TestRunner(config.model, 3, config.testPlacement || 'separate');
      const stats = cacheRunner.getCacheStats();
      console.log(`
      📊 Test Cache Statistics:
        Total tests in cache: ${stats.total}
        ✅ Passed: ${stats.passed}
        ❌ Failed: ${stats.failed}
        📈 Success rate: ${stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(2) : 0}%
        
        By placement strategy:
          Separate (__tests__): passed=${stats.byPlacement.separate.passed}, failed=${stats.byPlacement.separate.failed}
          Adjacent (next to source): passed=${stats.byPlacement.adjacent.passed}, failed=${stats.byPlacement.adjacent.failed}
        `);
      break;

    case 'clear-cache':
      const clearRunner = new TestRunner(config.model);
      clearRunner.clearCache();
      console.log('✅ Test cache cleared successfully');
      break;

    case 'generate-and-test':
      console.log('🚀 Starting full pipeline: Generation -> Testing -> Fixing\n');
      await generator.generateForDirectory();
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(`
Usage:
  npm run generate [command] [options]

Commands:
  all                    Generate tests for all files (default)
  file <path>           Generate test for a single file
  test [path]           Run all tests
  fix [path] [source]   Fix all failing tests
  fix-file <path> [source] Fix a specific test file
  generate-and-test     Generate and automatically test
  cache-stats           Show test cache statistics
  clear-cache           Clear test cache
  list-models           List available Ollama models
  help                  Show this help

Options:
  --components=<dir>    Source directory (default: ./src)
  --output=<dir>        Output directory (default: ./src/__tests__)
  --model=<name>        Ollama model name (default: qwen2.5-coder:7b)
  --exclude=<pattern>   Comma-separated exclude patterns
  --auto-fix            Automatically fix failing tests after generation
  --max-attempts=<n>    Max fix attempts per test (default: 3)
  --skip-passing        Skip generating tests that already exist and pass
  --force               Force regenerate all tests (ignore cache)
  --adjacent            Place test files next to source files (default: separate __tests__ folder)

Test Placement Strategies:
  default (separate):   src/components/Button.tsx -> src/components/__tests__/Button.test.tsx
  --adjacent:           src/components/Button.tsx -> src/components/Button.test.tsx

Examples:
  # Generate tests in separate __tests__ folders (default)
  npm run generate all -- --components=./src
  
  # Generate tests adjacent to source files
  npm run generate all -- --components=./src --adjacent
  
  # Generate only missing or failing tests with adjacent placement
  npm run generate:smart -- --adjacent
  
  # Generate and automatically fix failing tests
  npm run generate-and-test -- --components=./src --skip-passing --auto-fix --adjacent
  
  # Show cache statistics
  npm run cache-stats
  
  # Clear test cache
  npm run clear-cache
  
  # Run tests with force (ignore cache)
  npm run test -- --force
      `);
      break;

    case 'all':
    default:
      await generator.generateForDirectory();
      break;
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { TestGenerator, Config };
