import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @IsString({
    message:
      'refreshToken must be the refresh token string you received at sign-in.',
  })
  @IsNotEmpty({
    message:
      'refreshToken is required — send the refresh token you received at sign-in.',
  })
  refreshToken!: string;
}
