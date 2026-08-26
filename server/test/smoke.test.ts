import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests', () => {
    const x: number = 2;
    expect(x + 2).toBe(4);
  });
});
