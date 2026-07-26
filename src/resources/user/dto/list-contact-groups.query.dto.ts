import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/transforms/trim';
import { CONTACT_GROUP_NAME_MAX_LENGTH } from '../constant/users.constants';

/**
 * Query for `GET /me/contact-groups`. Deliberately unpaginated: groups are
 * labels a person types by hand, so a list long enough to need paging has
 * never existed.
 */
export class ListContactGroupsQueryDto {
  /** Case-insensitive partial match on the group name. */
  @IsOptional()
  @Trim()
  @IsString({ message: 'q must be a string.' })
  @MaxLength(CONTACT_GROUP_NAME_MAX_LENGTH, {
    message: `q must be ${CONTACT_GROUP_NAME_MAX_LENGTH} characters or fewer.`,
  })
  q?: string;
}
