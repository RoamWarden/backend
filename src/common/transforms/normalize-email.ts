import { Transform } from 'class-transformer';

/**
 * Canonical email form used everywhere: trimmed + lowercased. Email is
 * case-insensitive in practice, but the `users.email` column is a plain
 * (case-sensitive) unique string, so we normalise at every boundary instead of
 * relying on citext. Keep this the single definition so lookups and the stored
 * value always agree.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * DTO field decorator that normalises an email during class-transformer's
 * transform phase — i.e. BEFORE validation and before it reaches any service.
 * So `John@X.com ` and `john@x.com` resolve to the same account.
 */
export function NormalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  );
}
