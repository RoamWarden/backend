import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../common/transforms/trim';
import { CONTACT_GROUP_NAME_MAX_LENGTH } from '../constant/users.constants';

/**
 * Body of `PATCH /me/contact-groups/:id`. Omitted fields are left unchanged.
 *
 * READ THIS ABOUT `contactIds`: when present it REPLACES the whole membership,
 * so `[]` empties the group and a list of three leaves exactly those three.
 * When absent the membership is untouched. That is what lets the app send a
 * rename on its own without having to re-send (and risk truncating) a roster it
 * may not have loaded.
 */
export class UpdateContactGroupDto {
  /** Cannot be cleared — omit to keep the current name. */
  @ValidateIf((o: UpdateContactGroupDto) => o.name !== undefined)
  @Trim()
  @IsString({ message: 'name must be a string.' })
  @IsNotEmpty({
    message: 'name cannot be empty — omit it to keep the current name.',
  })
  @MaxLength(CONTACT_GROUP_NAME_MAX_LENGTH, {
    message: `name must be ${CONTACT_GROUP_NAME_MAX_LENGTH} characters or fewer.`,
  })
  name?: string;

  @IsOptional()
  @IsBoolean({ message: 'favorite must be true or false.' })
  favorite?: boolean;

  /** Present ⇒ the new complete membership. Absent ⇒ leave membership alone. */
  @IsOptional()
  @IsArray({ message: 'contactIds must be an array of contact ids' })
  @IsUUID('all', {
    each: true,
    message: 'each contactIds entry must be a valid UUID',
  })
  contactIds?: string[];
}
