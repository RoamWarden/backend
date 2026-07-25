import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { HANDOFF_TOKEN_MAX_LENGTH } from '../constant/auth.constants';

/**
 * Body for POST /auth/handoff — the single-use token the app put in the account
 * URL, exchanged by the web account page for a real session.
 */
export class HandoffDto {
  @IsString({
    message: 'token must be the hand-off token from your account link.',
  })
  @IsNotEmpty({
    message:
      'token is required — open your account from the app to get a fresh link.',
  })
  @MaxLength(HANDOFF_TOKEN_MAX_LENGTH, {
    message: 'token is not a valid hand-off token.',
  })
  token!: string;
}
