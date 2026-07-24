import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { NormalizeEmail } from '../../../common/transforms/normalize-email';

export class LoginDto {
  @IsEmail({}, { message: 'email must be a valid email address.' })
  @NormalizeEmail()
  email!: string;

  @IsString({ message: 'password must be a string.' })
  @IsNotEmpty({ message: 'password is required.' })
  password!: string;
}
