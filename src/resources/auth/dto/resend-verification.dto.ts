import { IsEmail } from 'class-validator';
import { NormalizeEmail } from '../../../common/transforms/normalize-email';

export class ResendVerificationDto {
  @IsEmail({}, { message: 'email must be a valid email address.' })
  @NormalizeEmail()
  email!: string;
}
