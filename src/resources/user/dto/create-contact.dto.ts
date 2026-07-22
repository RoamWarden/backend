import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Body of POST /me/contacts. At least one of phone / email / contactUserId is
 * required (enforced in UsersService so the merged rule also covers PATCH).
 */
export class CreateContactDto {
  @IsString({ message: 'name must be a string.' })
  @IsNotEmpty({ message: 'name is required — who is this trusted contact?' })
  @MaxLength(120, { message: 'name must be 120 characters or fewer.' })
  name!: string;

  @IsOptional()
  @IsString({ message: 'phone must be a string.' })
  @MaxLength(32, { message: 'phone must be 32 characters or fewer.' })
  phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address.' })
  email?: string;

  /** Id of a RoamWarden user to link this contact to (enables in-app alerts). */
  @IsOptional()
  @IsUUID('all', {
    message: 'contactUserId must be a RoamWarden user id (UUID).',
  })
  contactUserId?: string;

  /** e.g. "sister", "colleague". */
  @IsOptional()
  @IsString({ message: 'relation must be a string.' })
  @MaxLength(60, { message: 'relation must be 60 characters or fewer.' })
  relation?: string;
}
