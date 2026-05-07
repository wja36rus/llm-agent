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

  it('returns the last element of an array', () => {
    expect(getCurrentEnd([1, 2, 3])).toBe(3);
  });

  it('returns the last property of an object', () => {
    expect(getCurrentEnd({ a: 1, b: 2, c: 3 })).toBe(3);
  });

  it('handles null input', () => {
    expect(getCurrentEnd(null)).toBe(undefined);
  });

  it('handles undefined input', () => {
    expect(getCurrentEnd(undefined)).toBe(undefined);
  });
});