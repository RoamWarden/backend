import { IsEmail, MaxLength } from 'class-validator';
import { NormalizeEmail } from '../../../common/transforms/normalize-email';
import { INVITE_EMAIL_MAX_LENGTH } from '../constant/groups.constants';

/**
 * Body of POST /groups/:groupId/invites.
 *
 * An email address, NOT a user id — and the address alone never joins anyone.
 * The invitation is an offer; a `group_members` row appears only when a
 * signed-in user whose OWN verified email matches this address accepts it.
 * The response never reveals whether the address has a RoamWarden account.
 */
export class InviteMemberDto {
  @NormalizeEmail()
  @IsEmail(
    {},
    {
      message:
        'email must be a valid email address — the one the person you want to invite uses for RoamWarden.',
    },
  )
  @MaxLength(INVITE_EMAIL_MAX_LENGTH, {
    message: `email must be ${INVITE_EMAIL_MAX_LENGTH} characters or fewer.`,
  })
  email!: string;
}
