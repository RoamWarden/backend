import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Trim } from '../../../common/transforms/trim';

/**
 * Query for `GET /me/contacts/page` — the paged, searchable view of the
 * caller's OWN trusted contacts.
 *
 * `q` is a partial match and that is safe here, unlike
 * `POST /me/contacts/lookup`: this only ever searches rows the caller already
 * owns, so there is no account-enumeration surface to protect. Nothing in this
 * query can reach another user's contacts.
 */
export class ListContactsQueryDto {
  /** Case-insensitive partial match across name, email AND phone. */
  @IsOptional()
  @Trim()
  @IsString({ message: 'q must be a string.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be a whole number' })
  @Min(1, { message: 'page must be at least 1' })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be a whole number' })
  @Min(1, { message: 'limit must be at least 1' })
  limit?: number;
}
