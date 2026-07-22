import { Module } from '@nestjs/common';
import { MailModule } from '../../providers/mail/mail.module';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

/**
 * Early-access waitlist: public join + count, admin listing. PrismaService is
 * global; MailModule supplies the best-effort confirmation email. AdminGuard
 * (used via @UseGuards on the admin route) resolves from its global deps, so it
 * needs no explicit provider entry — matching ReportsModule.
 */
@Module({
  imports: [MailModule],
  controllers: [WaitlistController],
  providers: [WaitlistService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
