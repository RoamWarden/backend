import { DevicePlatform } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body of POST /me/devices — registers/refreshes an FCM device token. */
export class RegisterDeviceDto {
  @IsString({ message: 'token must be a string.' })
  @IsNotEmpty({ message: 'token is required — send the FCM device token.' })
  @MaxLength(512, {
    message: 'token looks too long to be a valid FCM device token.',
  })
  token!: string;

  @IsEnum(DevicePlatform, { message: "platform must be 'IOS' or 'ANDROID'." })
  platform!: DevicePlatform;
}
