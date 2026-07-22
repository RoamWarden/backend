import { parseDurationSeconds } from './duration.util';

describe('parseDurationSeconds', () => {
  it('parses seconds suffix', () => {
    expect(parseDurationSeconds('45s')).toBe(45);
  });

  it('parses minutes suffix', () => {
    expect(parseDurationSeconds('15m')).toBe(15 * 60);
  });

  it('parses hours suffix', () => {
    expect(parseDurationSeconds('24h')).toBe(24 * 3600);
  });

  it('parses days suffix', () => {
    expect(parseDurationSeconds('30d')).toBe(30 * 86400);
  });

  it('parses a plain number of seconds', () => {
    expect(parseDurationSeconds('3600')).toBe(3600);
    expect(parseDurationSeconds('0')).toBe(0);
  });

  it('accepts uppercase unit suffixes', () => {
    expect(parseDurationSeconds('2H')).toBe(2 * 3600);
    expect(parseDurationSeconds('10M')).toBe(10 * 60);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDurationSeconds('  15m  ')).toBe(15 * 60);
    expect(parseDurationSeconds(' 3600 ')).toBe(3600);
  });

  it('tolerates whitespace between the number and the unit', () => {
    expect(parseDurationSeconds('15 m')).toBe(15 * 60);
  });

  it('throws on non-numeric garbage', () => {
    expect(() => parseDurationSeconds('abc')).toThrow();
  });

  it('throws on an unknown unit', () => {
    expect(() => parseDurationSeconds('5x')).toThrow();
  });

  it('throws on the empty string', () => {
    expect(() => parseDurationSeconds('')).toThrow();
  });

  it('includes the value and default label in the thrown message', () => {
    expect(() => parseDurationSeconds('abc')).toThrow(
      'Cannot parse duration: "abc"',
    );
  });

  it('includes a custom label in the thrown message', () => {
    expect(() => parseDurationSeconds('nope', 'JWT_ACCESS_TTL')).toThrow(
      'Cannot parse JWT_ACCESS_TTL: "nope"',
    );
  });
});
