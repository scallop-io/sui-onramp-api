import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SuiAddress,
  CryptoSymbol,
  NetworkName,
  FiatCode,
  DecimalAmount,
} from '../src/lib/validation.ts';

describe('SuiAddress', () => {
  const valid = `0x${'a'.repeat(64)}`;
  test('accepts a 0x + 64-hex address', () => {
    assert.equal(SuiAddress.safeParse(valid).success, true);
  });
  for (const bad of [
    '',
    '0xabc',
    'a'.repeat(66),
    `0x${'g'.repeat(64)}`, // non-hex
    `0x${'a'.repeat(63)}`, // too short
    `0x${'a'.repeat(65)}`, // too long
    `${`0x${'a'.repeat(64)}`}&fiatAmount=1`, // delimiter injection
  ]) {
    test(`rejects: ${JSON.stringify(bad).slice(0, 24)}…`, () => {
      assert.equal(SuiAddress.safeParse(bad).success, false);
    });
  }
});

describe('DecimalAmount', () => {
  for (const ok of ['1', '100', '0.5', '1234.5678']) {
    test(`accepts ${ok}`, () => assert.equal(DecimalAmount.safeParse(ok).success, true));
  }
  for (const bad of ['0', '-1', '1e9', '0x10', 'abc', '', '1.2.3', ' 1', '100; DROP']) {
    test(`rejects ${JSON.stringify(bad)}`, () =>
      assert.equal(DecimalAmount.safeParse(bad).success, false));
  }
});

describe('symbol / network / fiat charsets reject delimiters', () => {
  test('CryptoSymbol rejects &', () =>
    assert.equal(CryptoSymbol.safeParse('SUI&x=1').success, false));
  test('NetworkName rejects =', () =>
    assert.equal(NetworkName.safeParse('SUI=x').success, false));
  test('FiatCode requires exactly 3 letters', () => {
    assert.equal(FiatCode.safeParse('USD').success, true);
    assert.equal(FiatCode.safeParse('US').success, false);
    assert.equal(FiatCode.safeParse('US1').success, false);
    assert.equal(FiatCode.safeParse('&=x').success, false);
  });
});
