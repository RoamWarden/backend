import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsString, ValidateIf } from 'class-validator';

export class GoogleAuthDto {
  @IsString({
    message: 'idToken must be the Google ID token string from Google Sign-In.',
  })
  @IsNotEmpty({
    message:
      'idToken is required — send the Google ID token from Google Sign-In.',
  })
  idToken!: string;

  /**
   * May a verified Google identity that matches NO existing account create one?
   *
   * Omitted → true, so the mobile app (which sends only `idToken`) keeps its
   * current sign-up-on-first-sign-in behaviour, unchanged.
   *
   * The website sends `false`: accounts are built in the app (verified email,
   * push token, trusted contacts), so a web-created account would be a
   * half-configured shell. In that mode an unknown identity is refused with
   * 404 `{ code: 'NO_ACCOUNT' }` and nothing is written. Signing in to an
   * account that already exists — including linking Google onto an email +
   * password account — is unaffected: that is a sign-in, not a sign-up.
   *
   * The @Transform re-reads the RAW body value on purpose. The global
   * ValidationPipe runs with `enableImplicitConversion`, which would turn the
   * string "false" into `Boolean('false') === true` and silently re-enable
   * sign-up. Reading the raw value means anything that is not a real JSON
   * boolean fails @IsBoolean with a clear 400, instead of failing open.
   *
   * @ValidateIf rather than @IsOptional for the same reason: @IsOptional would
   * also wave through an explicit `null`, which then falls back to "allowed".
   * Only a genuinely ABSENT field is optional; a sent-but-malformed one is a
   * 400 the caller can see and fix.
   */
  @Transform(
    ({ obj }: { obj: Record<string, unknown> | undefined }): unknown =>
      obj?.allowSignup,
  )
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean({
    message:
      'allowSignup must be a JSON boolean — true to allow creating an account, false to only sign in to an existing one.',
  })
  allowSignup?: boolean;
}
