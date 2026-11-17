import { describe, expect, it } from 'vitest';
import { formatTokens } from '../../src/report/format.ts';

describe('formatTokens', () => {
  it('rounds before choosing the unit, so the value carries over', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_000)).toBe('1.0k');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(999_949)).toBe('999.9k');
    expect(formatTokens(999_950)).toBe('1.0M');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});
