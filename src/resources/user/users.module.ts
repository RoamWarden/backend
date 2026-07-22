import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Profile, trusted contacts and device tokens. Exports UsersService for the
 * auth (Google login upsert), sos and alerts modules (contact lookups).
 * PrismaModule is global, so no imports are needed here.
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
