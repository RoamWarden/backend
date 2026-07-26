import { Transform } from 'class-transformer';

/**
 * DTO field decorator that trims a string during class-transformer's transform
 * phase — i.e. BEFORE validation and before it reaches any service.
 *
 * Order matters: because this runs first, `"   "` arrives at the validators as
 * `""` and is caught by `@IsNotEmpty`, instead of being stored as a name made
 * entirely of spaces that no `@MaxLength`/`@IsNotEmpty` pair would ever reject.
 * It also means a trailing space cannot smuggle a second "Family" past a unique
 * constraint.
 *
 * Non-strings are passed through untouched so the type validators, not this
 * transform, produce the error message.
 */
export function Trim(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  );
}
