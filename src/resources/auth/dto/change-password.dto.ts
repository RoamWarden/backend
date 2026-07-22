import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH } from '../../../common/constants';

export class ChangePasswordDto {
  @IsString({ message: 'currentPassword must be a string.' })
  @IsNotEmpty({ message: 'currentPassword is required.' })
  currentPassword!: string;

  @IsString({ message: 'newPassword must be a string.' })
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `newPassword must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
  })
  newPassword!: string;
}
