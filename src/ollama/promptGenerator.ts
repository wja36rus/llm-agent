import { FunctionInfo } from "./analyzer";

export class PromptGenerator {
  private componentExample: string;
  private utilityExample: string;

  constructor(examplePath?: string) {
    // Пример для React компонента
    this.componentExample = `
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button Component', () => {
  it('renders button with correct text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: /click me/i })).toBeInTheDocument();
  });

  it('calls onClick handler when clicked', () => {
    const handleClick = jest.fn();
    render(<Button onClick={handleClick}>Click me</Button>);
    
    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
    `;

    // Пример для утилиты
    this.utilityExample = `
import { getCurrentEnd } from './utils';

describe('getCurrentEnd', () => {
  it('returns the last character of a string', () => {
    expect(getCurrentEnd('hello')).toBe('o');
    expect(getCurrentEnd('world')).toBe('d');
  });

  it('handles empty string', () => {
    expect(getCurrentEnd('')).toBe(undefined);
  });

  it('handles single character string', () => {
    expect(getCurrentEnd('a')).toBe('a');
  });

  it('handles special characters', () => {
    expect(getCurrentEnd('hello!')).toBe('!');
    expect(getCurrentEnd('привет')).toBe('т');
  });
});
    `;
  }

  generatePrompt(funcInfo: FunctionInfo, code: string): string {
    if (funcInfo.type === "component") {
      return this.generateComponentPrompt(funcInfo, code);
    } else {
      return this.generateUtilityPrompt(funcInfo, code);
    }
  }

  private generateComponentPrompt(
    funcInfo: FunctionInfo,
    code: string,
  ): string {
    const paramsStr = funcInfo.params
      .map(
        (p) =>
          `${p.name}${p.optional ? "?" : ""}${p.type ? ": " + p.type : ""}`,
      )
      .join(", ");

    return `Ты — Senior Frontend Engineer, специализирующийся на тестировании React компонентов.

Твоя задача: написать тесты для React компонента с использованием Jest и React Testing Library.

ВАЖНЫЕ ПРАВИЛА:
1. Всегда используй screen.getByRole для поиска элементов
2. Всегда используй fireEvent или userEvent для симуляции действий
3. Никогда не используй enzyme
4. Всегда мокай функции с помощью jest.fn()
5. Используй describe и it для организации тестов

ВОТ ПРИМЕР ТОГО, КАК ДОЛЖНЫ ВЫГЛЯДЕТЬ ТЕСТЫ:
${this.componentExample}

ИНФОРМАЦИЯ О КОМПОНЕНТЕ:
Имя: ${funcInfo.name}
Тип: ${funcInfo.type}
Параметры: ${paramsStr || "нет"}
Возвращает: ${funcInfo.returnType || "unknown"}
Использует хуки: ${funcInfo.hooks.join(", ") || "нет"}
JSX элементы: ${funcInfo.jsxElements.join(", ") || "нет"}
Асинхронный: ${funcInfo.isAsync ? "да" : "нет"}
${funcInfo.description ? `Описание: ${funcInfo.description}` : ""}

КОД КОМПОНЕНТА:
\`\`\`tsx
${code}
\`\`\`

ТРЕБОВАНИЯ К ТЕСТАМ:
1. Проверь, что компонент рендерится без ошибок
2. Протестируй все пропсы, которые принимает компонент
3. Если есть колбэки (onClick, onChange и т.д.) — проверь их вызовы
4. Проверь состояния загрузки, disabled, ошибок
5. Протестируй условный рендеринг, если он есть

Сгенерируй ТОЛЬКО код теста без комментариев. Используй формат .test.tsx.

Код теста:`;
  }

  private generateUtilityPrompt(funcInfo: FunctionInfo, code: string): string {
    const paramsStr = funcInfo.params
      .map(
        (p) =>
          `${p.name}${p.optional ? "?" : ""}${p.type ? ": " + p.type : ""}`,
      )
      .join(", ");

    // Генерируем тест-кейсы на основе параметров
    const testCases = this.generateTestCases(funcInfo);

    return `Ты — Senior Frontend Engineer, специализирующийся на тестировании утилит и хелперов.

Твоя задача: написать тесты для утилиты с использованием Jest.

ВАЖНЫЕ ПРАВИЛА:
1. Используй чистые функции и детерминированные тесты
2. Тестируй граничные случаи (empty, null, undefined)
3. Используй describe для группировки связанных тестов
4. Каждый it должен тестировать один конкретный случай
5. Используй expect с соответствующими matchers

ВОТ ПРИМЕР ТОГО, КАК ДОЛЖНЫ ВЫГЛЯДЕТЬ ТЕСТЫ ДЛЯ УТИЛИТ:
${this.utilityExample}

ИНФОРМАЦИЯ О ФУНКЦИИ:
Имя: ${funcInfo.name}
Тип: ${funcInfo.type}
Параметры: ${paramsStr || "нет"}
Возвращает: ${funcInfo.returnType || "unknown"}
Асинхронная: ${funcInfo.isAsync ? "да" : "нет"}
Экспортируется: да
${funcInfo.description ? `Описание: ${funcInfo.description}` : ""}

КОД ФУНКЦИИ:
\`\`\`typescript
${code}
\`\`\`

РЕКОМЕНДУЕМЫЕ ТЕСТ-КЕЙСЫ:
${testCases}

ТРЕБОВАНИЯ К ТЕСТАМ:
1. Протестируй нормальное поведение с корректными входными данными
2. Протестируй граничные случаи (пустые значения, null, undefined)
3. Если функция асинхронная — используй async/await
4. Проверь типы возвращаемых значений
5. Добавь тесты на исключения, если функция может их выбрасывать

Сгенерируй ТОЛЬКО код теста без комментариев. Используй формат .test.ts или .test.ts.

Код теста:`;
  }

  private generateTestCases(funcInfo: FunctionInfo): string {
    const cases: string[] = [];

    if (funcInfo.params.length === 0) {
      cases.push(
        "- Проверить, что функция возвращает ожидаемое значение без параметров",
      );
    }

    for (const param of funcInfo.params) {
      if (param.type === "string") {
        cases.push(
          `- Протестировать с нормальной строкой для параметра ${param.name}`,
        );
        cases.push(
          `- Протестировать с пустой строкой для параметра ${param.name}`,
        );
        if (!param.optional) {
          cases.push(
            `- Убедиться, что функция выбрасывает ошибку без обязательного параметра ${param.name}`,
          );
        }
      } else if (param.type === "number") {
        cases.push(
          `- Протестировать с положительным числом для параметра ${param.name}`,
        );
        cases.push(
          `- Протестировать с отрицательным числом для параметра ${param.name}`,
        );
        cases.push(`- Протестировать с нулем для параметра ${param.name}`);
      } else if (param.type === "boolean") {
        cases.push(`- Протестировать с true для параметра ${param.name}`);
        cases.push(`- Протестировать с false для параметра ${param.name}`);
      } else if (param.type?.includes("[]")) {
        cases.push(
          `- Протестировать с пустым массивом для параметра ${param.name}`,
        );
        cases.push(
          `- Протестировать с массивом из одного элемента для параметра ${param.name}`,
        );
        cases.push(
          `- Протестировать с большим массивом для параметра ${param.name}`,
        );
      }
    }

    if (funcInfo.isAsync) {
      cases.push("- Использовать async/await для асинхронной функции");
      cases.push("- Проверить обработку ошибок с try/catch или .rejects");
    }

    if (funcInfo.returnType === "string") {
      cases.push("- Проверить, что возвращаемое значение является строкой");
    } else if (funcInfo.returnType === "number") {
      cases.push("- Проверить, что возвращаемое значение является числом");
    }

    return cases.length > 0
      ? cases.join("\n")
      : "- Стандартные тесты для функции";
  }
}
