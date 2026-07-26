import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Trim } from '../../../common/transforms/trim';
import { CONTACT_GROUP_NAME_MAX_LENGTH } from '../constant/users.constants';

/**
 * Body of `POST /me/contact-groups`.
 *
 * A group is a private label over contacts the caller ALREADY has: every id in
 * `contactIds` must belong to them, which UsersService checks (and reports as a
 * 400 naming the offending ids) exactly the way createTrip checks
 * `watcherContactIds`.
 */
export class CreateContactGroupDto {
  /** Trimmed before validation, so "   " is an empty name, not a valid one. */
  @Trim()
  @IsString({ message: 'name must be a string.' })
  @IsNotEmpty({
    message:
      'name is required — what should this group be called? e.g. "Family".',
  })
  @MaxLength(CONTACT_GROUP_NAME_MAX_LENGTH, {
    message: `name must be ${CONTACT_GROUP_NAME_MAX_LENGTH} characters or fewer.`,
  })
  name!: string;

  /** Omit (or send []) to create an empty group and fill it later. */
  @IsOptional()
  @IsArray({ message: 'contactIds must be an array of contact ids' })
  @IsUUID('all', {
    each: true,
    message: 'each contactIds entry must be a valid UUID',
  })
  contactIds?: string[];

  /** Pins the group to the top of the caller's own list. Defaults to false. */
  @IsOptional()
  @IsBoolean({ message: 'favorite must be true or false.' })
  favorite?: boolean;
}
