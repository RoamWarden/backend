import { IsEmail, MaxLength } from 'class-validator';
import { NormalizeEmail } from '../../../common/transforms/normalize-email';

/**
 * Body of POST /me/contacts/lookup.
 *
 * ONE field, and it must be a whole address. There is deliberately no prefix,
 * partial, wildcard or "q" search here: anything less than an exact address
 * turns this endpoint into a browsable directory of our users. `@NormalizeEmail`
 * trims and lowercases before validation, so `  Ada@Example.COM ` finds the same
 * account as `ada@example.com` — the same canonical form the row was stored in.
 */
export class LookupContactUserDto {
  @IsEmail(
    {},
    {
      message:
        "That doesn't look like an email address. Enter the full address they signed up with, e.g. ada@example.com.",
    },
  )
  @MaxLength(320, {
    message: 'That email address is too long to be a real one.',
  })
  @NormalizeEmail()
  email!: string;
}
