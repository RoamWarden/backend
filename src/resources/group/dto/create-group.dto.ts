import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { GROUP_NAME_MAX_LENGTH } from '../constant/groups.constants';

/** Body of POST /groups. */
export class CreateGroupDto {
  @IsString({ message: 'name must be a string.' })
  @IsNotEmpty({
    message:
      'name is required — what should this group be called? e.g. "Family".',
  })
  @MaxLength(GROUP_NAME_MAX_LENGTH, {
    message: `name must be ${GROUP_NAME_MAX_LENGTH} characters or fewer.`,
  })
  name!: string;
}
