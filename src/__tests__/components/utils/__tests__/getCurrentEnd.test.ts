import { getCurrentEnd } from '../../../../components/utils/getCurrentEnd';

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

  it('returns undefined for null input', () => {
    expect(getCurrentEnd(null as any)).toBe(undefined);
  });

  it('returns undefined for undefined input', () => {
    expect(getCurrentEnd(undefined as any)).toBe(undefined);
  });
});