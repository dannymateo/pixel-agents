import { describe, expect, it } from 'vitest';

import { isLoopbackHost } from '../src/terminals/loadNodePty.js';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('%s is loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  it.each(['0.0.0.0', '::', '', '192.168.1.10', 'my-pc'])('%s is not', (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});
