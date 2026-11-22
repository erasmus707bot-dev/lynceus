const { classify, slowDouble } = require('./calc');

describe('classify', () => {
  test('negative', () => { expect(classify(-5)).toBe('negative'); });
  it('loop', () => { expect(classify(10)).toEqual('big'); });
  it('fails on purpose', () => { expect(classify(0)).toBe('small'); });
});

describe('async', () => {
  it('resolves', async () => { await expect(slowDouble(2)).resolves.toBe(4); });
  it('throws', () => { expect(() => { throw new Error('boom'); }).toThrow('boom'); });
  it('uses fs', () => { require('fs'); });
});
