/**
 * Parses a human duration ("15m", "30d", "24h", "45s", or a plain number of
 * seconds) into seconds. Throws on unparseable input so misconfigured TTLs
 * fail loudly at boot instead of silently issuing eternal tokens.
 */
export function parseDurationSeconds(
  value: string,
  label = 'duration',
): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(trimmed);
  if (!match) {
    throw new Error(
      `Cannot parse ${label}: "${value}". Use seconds or <n>s|m|h|d (e.g. "15m", "30d").`,
    );
  }
  const n = Number(match[1]);
  switch (match[2].toLowerCase()) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      throw new Error(`Cannot parse ${label}: "${value}"`);
  }
}
