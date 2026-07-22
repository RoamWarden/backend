import { IsNotEmpty, IsString } from 'class-validator';

export class GoogleAuthDto {
  @IsString({
    message: 'idToken must be the Google ID token string from Google Sign-In.',
  })
  @IsNotEmpty({
    message:
      'idToken is required — send the Google ID token from Google Sign-In.',
  })
  idToken!: string;
}
