import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH } from '../../../common/constants';

export class ResetPasswordDto {
  @IsString({ message: 'token must be the reset token from your email link.' })
  @IsNotEmpty({
    message: 'token is required — use the link from your reset email.',
  })
  token!: string;

  @IsString({ message: 'password must be a string.' })
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
  })
  password!: string;
}
