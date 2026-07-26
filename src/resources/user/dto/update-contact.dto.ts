import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Body of PATCH /me/contacts/:id. Omitted fields are left unchanged; nullable
 * fields accept null to clear. The "at least one of phone/email/contactUserId"
 * rule is re-checked against the merged result in UsersService.
 */
export class UpdateContactDto {
  /** Cannot be cleared — omit to keep the current name. */
  @ValidateIf((o: UpdateContactDto) => o.name !== undefined)
  @IsString({ message: 'name must be a string.' })
  @IsNotEmpty({
    message: 'name cannot be empty — omit it to keep the current name.',
  })
  @MaxLength(120, { message: 'name must be 120 characters or fewer.' })
  name?: string;

  /** Send null to clear. */
  @IsOptional()
  @IsString({ message: 'phone must be a string.' })
  @MaxLength(32, { message: 'phone must be 32 characters or fewer.' })
  phone?: string | null;

  /** Send null to clear. */
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address.' })
  email?: string | null;

  /** Send null to unlink the RoamWarden account. */
  @IsOptional()
  @IsUUID('all', {
    message: 'contactUserId must be a RoamWarden user id (UUID).',
  })
  contactUserId?: string | null;

  /** Send null to clear. */
  @IsOptional()
  @IsString({ message: 'relation must be a string.' })
  @MaxLength(60, { message: 'relation must be 60 characters or fewer.' })
  relation?: string | null;

  /**
   * Pins this contact to the top of the caller's own list. A display preference
   * only — it grants no extra reach and changes nothing about who is notified.
   * Not nullable: the column has no "unset" state, so un-favouriting is `false`.
   */
  @IsOptional()
  @IsBoolean({ message: 'favorite must be true or false.' })
  favorite?: boolean;
}
