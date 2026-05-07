import { useGetEndOfStringtsts } from '../../../../components/hook/useGetEndOfString';
import { getCurrentEnd } from '../utils/getCurrentEnd';

describe('useGetEndOfStringtsts', () => {
  it('returns the last character of a string', () => {
    expect(useGetEndOfStringtsts({ text: 'hello' })).toBe('o');
    expect(useGetEndOfStringtsts({ text: 'world' })).toBe('d');
  });

  it('handles empty string', () => {
    expect(useGetEndOfStringtsts({ text: '' })).toBe(undefined);
  });

  it('handles single character string', () => {
    expect(useGetEndOfStringtsts({ text: 'a' })).toBe('a');
  });

  it('handles special characters', () => {
    expect(useGetEndOfStringtsts({ text: 'hello!' })).toBe('!');
    expect(useGetEndOfStringtsts({ text: 'привет' })).toBe('т');
  });

  it('returns undefined for null input', () => {
    expect(useGetEndOfStringtsts({ text: null })).toBe(undefined);
  });

  it('returns undefined for undefined input', () => {
    expect(useGetEndOfStringtsts({ text: undefined })).toBe(undefined);
  });
});