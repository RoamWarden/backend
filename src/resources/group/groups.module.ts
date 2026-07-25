import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notification/notifications.module';
import { UsersModule } from '../user/users.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

/**
 * Family / group plan (build plan §20, Premium capability `familyPlan`).
 *
 * UsersModule is imported for ONE reason: `filterConsentingContactUserIds`, the
 * mutual-consent gate that group fan-out must go through
 * (GroupsService.getConsentingGroupMemberUserIds). NotificationsModule pushes a
 * best-effort heads-up to an invited address that already has an account.
 *
 * PrismaModule and EntitlementsModule are @Global, so neither is imported here.
 *
 * Exports GroupsService so a future feature can ask for the CONSENTING subset
 * of a roster. Nothing outside this module may read `group_members` directly to
 * build a location audience — see the privacy contract in groups.service.ts.
 */
@Module({
  imports: [UsersModule, NotificationsModule],
  controllers: [GroupsController],
  providers: [GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
