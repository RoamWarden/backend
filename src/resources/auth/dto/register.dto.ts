import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH } from '../../../common/constants';

export class RegisterDto {
  @IsEmail({}, { message: 'email must be a valid email address.' })
  email!: string;

  @IsString({ message: 'password must be a string.' })
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
  })
  password!: string;

  @IsString({ message: 'name must be a string.' })
  @IsNotEmpty({ message: 'name is required — tell us what to call you.' })
  name!: string;
}
