import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { JoinWaitlistDto } from './dto/join-waitlist.dto';
import { ListWaitlistQueryDto } from './dto/list-waitlist.query.dto';
import type {
  JoinWaitlistResult,
  WaitlistCountResult,
  WaitlistListResult,
} from './type/waitlist.types';
import { WaitlistService } from './waitlist.service';

@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlistService: WaitlistService) {}

  /** Landing-page signup. Public and hard-throttled against abuse. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async join(@Body() dto: JoinWaitlistDto): Promise<JoinWaitlistResult> {
    return this.waitlistService.join({ email: dto.email, source: dto.source });
  }

  /** Public social-proof count. Declared before any dynamic route. */
  @Public()
  @Get('count')
  async count(): Promise<WaitlistCountResult> {
    const count = await this.waitlistService.count();
    return { count };
  }

  /** Admin: paginated listing of everyone on the waitlist. */
  @UseGuards(AdminGuard)
  @Get()
  async list(
    @Query() query: ListWaitlistQueryDto,
  ): Promise<WaitlistListResult> {
    return this.waitlistService.list({ page: query.page, limit: query.limit });
  }
}
