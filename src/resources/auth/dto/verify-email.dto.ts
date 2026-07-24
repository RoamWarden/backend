import { IsEmail, IsString, Matches } from 'class-validator';
import { EMAIL_OTP_LENGTH } from '../../../common/constants';

export class VerifyEmailDto {
  @IsEmail({}, { message: 'email must be a valid email address.' })
  email!: string;

  @IsString({ message: 'code must be a string.' })
  @Matches(new RegExp(`^\\d{${EMAIL_OTP_LENGTH}}$`), {
    message: `code must be the ${EMAIL_OTP_LENGTH}-digit number from your email.`,
  })
  code!: string;
}
