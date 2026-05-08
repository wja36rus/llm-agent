import { getCurrentEnd } from '../../../../components/utils/getCurrentEnd';

describe('getCurrentEnd', () => {
  it('returns the last character of a string', () => {
    expect(getCurrentEnd('hello')).toBe('o');
    expect(getCurrentEnd('world')).toBe('d');
  });

  it('handles empty string', () => {
    expect(getCurrentEnd('')).toBe('');
  });

  it('handles null input', () => {
    expect(getCurrentEnd(null)).toBe('');
  });

  it('handles undefined input', () => {
    expect(getCurrentEnd(undefined)).toBe('');
  });

  it('returns the last character of a string with special characters', () => {
    expect(getCurrentEnd('hello!')).toBe('!');
    expect(getCurrentEnd('привет')).toBe('т');
  });

  it('returns an empty string for non-string input', () => {
    expect(getCurrentEnd(123)).toBe('');
    expect(getCurrentEnd(true)).toBe('');
    expect(getCurrentEnd({})).toBe('');
    expect(getCurrentEnd([])).toBe('');
  });
});