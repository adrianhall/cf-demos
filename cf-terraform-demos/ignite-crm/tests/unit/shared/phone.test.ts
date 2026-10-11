/**
 * @file Shared phone normalization: valid numbers become E.164, invalid ones and extensions are
 *   refused with a message that never echoes the input, and display keeps legacy text unchanged.
 */

import { describe, expect, it } from 'vitest';
import { displayPhone, normalizePhone } from '../../../src/shared/phone.ts';

describe('normalizePhone', () => {
  it('stores national, international, and punctuated numbers as E.164', () => {
    expect(normalizePhone('07523 185547', 'GB')).toBe('+447523185547');
    expect(normalizePhone('+44 (0)20 7946 0000', 'GB')).toBe('+442079460000');
    expect(normalizePhone('0044 117 496 0001', 'GB')).toBe('+441174960001');
    expect(normalizePhone('+1 212 555 0123', 'GB')).toBe('+12125550123');
  });

  it('treats blank as none', () => {
    expect(normalizePhone(null, 'GB')).toBeNull();
    expect(normalizePhone('   ', 'GB')).toBeNull();
  });

  it('refuses invalid numbers, extensions, and unknown regions', () => {
    for (const input of ['12345', 'abcd', '07523 18554', '020 7946 0000 ext. 123']) {
      expect(() => normalizePhone(input, 'GB')).toThrow(RangeError);
    }
    expect(() => normalizePhone('07523 185547', 'ZZ')).toThrow(
      'Enter a valid phone number, including an area code.'
    );
  });
});

describe('displayPhone', () => {
  it('formats local numbers nationally and foreign ones internationally', () => {
    expect(displayPhone('+447523185547', 'GB')).toBe('07523 185547');
    expect(displayPhone('+12125550123', 'GB')).toBe('+1 212 555 0123');
  });

  it('shows legacy free text and unparsable E.164-looking text unchanged', () => {
    expect(displayPhone(null, 'GB')).toBeNull();
    expect(displayPhone('call reception', 'GB')).toBe('call reception');
    expect(displayPhone('+999', 'GB')).toBe('+999');
  });
});
