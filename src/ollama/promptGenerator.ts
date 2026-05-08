// src/ollama/promptGenerator.ts
import { FunctionInfo } from './analyzer';

export class PromptGenerator {
  private componentExample: string;
  private utilityExample: string;

  constructor() {
    this.componentExample = `
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Button } from './Button';

describe('Button Component', () => {
  it('renders button with correct text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: /click me/i })).toBeInTheDocument();
  });

  it('calls onClick handler when clicked', () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click me</Button>);
    
    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
    `;

    this.utilityExample = `
import { describe, it, expect } from 'vitest';
import { getCurrentEnd } from './utils';

describe('getCurrentEnd', () => {
  it('returns the last character of a string', () => {
    expect(getCurrentEnd('hello')).toBe('o');
    expect(getCurrentEnd('world')).toBe('d');
  });

  it('handles empty string', () => {
    expect(getCurrentEnd('')).toBe(undefined);
  });
});
    `;
  }

  generatePrompt(funcInfo: FunctionInfo, code: string): string {
    if (funcInfo.type === 'component') {
      return this.generateComponentPrompt(funcInfo, code);
    } else {
      return this.generateUtilityPrompt(funcInfo, code);
    }
  }

  private generateComponentPrompt(funcInfo: FunctionInfo, code: string): string {
    // Безопасная проверка props
    const hasProps = funcInfo.props && Array.isArray(funcInfo.props) && funcInfo.props.length > 0;
    const callbackProps = hasProps && funcInfo.props ? funcInfo.props.filter((p: string) => p.startsWith('on')) : [];

    const paramsStr =
      funcInfo.params && funcInfo.params.length > 0
        ? funcInfo.params.map((p) => `${p.name}${p.optional ? '?' : ''}${p.type ? ': ' + p.type : ''}`).join(', ')
        : 'none';

    const specificPractices = this.generateComponentBestPractices(funcInfo);

    const interactionTests =
      callbackProps.length > 0
        ? callbackProps.map((p: string) => `- Test ${p} callback is called with correct arguments`).join('\n')
        : '- Test user interactions if any';

    const hooksList = funcInfo.hooks && funcInfo.hooks.length > 0 ? funcInfo.hooks.join(', ') : 'none';
    const jsxElementsList =
      funcInfo.jsxElements && funcInfo.jsxElements.length > 0 ? funcInfo.jsxElements.join(', ') : 'none';

    return `You are an expert React testing engineer using Vitest and Testing Library.

## CONTEXT
Component: ${funcInfo.name}
Type: ${funcInfo.type}
Props: ${paramsStr}
Returns: ${funcInfo.returnType || 'JSX.Element'}
Hooks used: ${hooksList}
JSX elements: ${jsxElementsList}
Async: ${funcInfo.isAsync ? 'yes' : 'no'}

## TEST REQUIREMENTS

### 1. Structure
- Use describe('${funcInfo.name}', () => { ... })
- Group tests by behavior (rendering, interactions, edge cases)

### 2. Rendering Tests
- Basic render with minimal required props
- Render with different prop combinations
- Conditional rendering verification

### 3. Interaction Tests
${interactionTests}

### 4. Edge Cases
- Test with undefined/null props
- Test with empty strings or arrays
- Test disabled/loading states

### 5. Async Behavior (if applicable)
${
  funcInfo.isAsync
    ? `- Test loading state
- Test error state with proper error message
- Test successful data fetch`
    : '- N/A'
}

### 6. Specific Recommendations for This Component:
${specificPractices || '- Follow standard testing patterns'}

## CODE TO TEST:
\`\`\`tsx
${code}
\`\`\`

## REQUIREMENTS FOR RESPONSE:
1. Use Vitest syntax: import { describe, it, expect, vi } from 'vitest'
2. Use Testing Library: import { render, screen, fireEvent } from '@testing-library/react'
3. Use jest-dom matchers: import '@testing-library/jest-dom/vitest'
4. Follow AAA pattern (Arrange, Act, Assert)
5. Use vi.fn() for mocks
6. Use screen.getByRole with name option when possible

Generate ONLY the test code. No explanations before or after.`;
  }

  private generateComponentBestPractices(componentInfo: FunctionInfo): string {
    const practices: string[] = [];

    // Безопасная проверка hooks
    const hooks = componentInfo.hooks || [];
    if (hooks.includes('useEffect')) {
      practices.push('- Test useEffect cleanup');
      practices.push('- Test dependency changes trigger effect');
    }

    if (hooks.includes('useState')) {
      practices.push('- Test state updates correctly');
    }

    // Проверяем callback props через params (более надежно)
    const params = componentInfo.params || [];
    const hasCallbackProps = params.some((p) => p.name && p.name.startsWith('on'));
    if (hasCallbackProps) {
      practices.push('- Test all callback props are called with correct arguments');
    }

    if (componentInfo.isAsync) {
      practices.push('- Test loading states');
      practices.push('- Test error states');
      practices.push('- Test successful data loading');
    }

    // Безопасная проверка jsxElements
    const jsxElements = componentInfo.jsxElements || [];
    if (jsxElements.includes('form')) {
      practices.push('- Test form submission');
      practices.push('- Test validation errors');
    }

    return practices.join('\n');
  }

  private generateUtilityPrompt(funcInfo: FunctionInfo, code: string): string {
    const paramsStr =
      funcInfo.params && funcInfo.params.length > 0
        ? funcInfo.params.map((p) => `${p.name}${p.optional ? '?' : ''}${p.type ? ': ' + p.type : ''}`).join(', ')
        : 'none';

    return `You are an expert in testing TypeScript/JavaScript utilities with Vitest.

## FUNCTION TO TEST
Name: ${funcInfo.name}
Parameters: ${paramsStr}
Returns: ${funcInfo.returnType || 'unknown'}
Async: ${funcInfo.isAsync ? 'yes' : 'no'}

## TEST REQUIREMENTS

### 1. Normal Cases
- Test with typical valid inputs
- Verify correct return values

### 2. Edge Cases
- Empty strings: ''
- Zero and negative numbers: 0, -1
- Empty arrays: []
- Empty objects: {}
- null and undefined

### 3. Error Cases
- Invalid input types
- Missing required parameters

### 4. Async Functions (if applicable)
${
  funcInfo.isAsync
    ? `- Test successful resolution
- Test rejection with proper error`
    : '- N/A'
}

## CODE TO TEST:
\`\`\`typescript
${code}
\`\`\`

## RESPONSE FORMAT:
Generate ONLY the test code with:
1. Proper imports from 'vitest'
2. describe block named '${funcInfo.name}'
3. Multiple it() blocks for each test case
4. Descriptive test names

Only output the test code, nothing else.`;
  }
}
