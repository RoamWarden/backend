import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Outbound email provider. Configured from SMTP_URL/MAIL_FROM; degrades to a
 * log-only mode when SMTP is unset. ConfigModule is global, so nothing else
 * needs importing here.
 */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
