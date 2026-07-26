import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CreateReportDto } from './dto/create-report.dto';
import { FindNearQueryDto } from './dto/find-near-query.dto';
import { FindReportsQueryDto } from './dto/find-reports-query.dto';
import { RemoveReportDto } from './dto/remove-report.dto';
import { VoteReportDto } from './dto/vote-report.dto';
import { ReportsService } from './reports.service';
import type { ReportView } from './type/reports.types';

const reportIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      'Report id must be a valid UUID — check the link or map pin and try again.',
    ),
});

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /** Throttled hard: reports are high-trust content (10 per user-hour window). */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  createReport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReportDto,
  ): Promise<ReportView> {
    return this.reportsService.createReport(user.id, dto);
  }

  @Post(':id/vote')
  vote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', reportIdPipe) reportId: string,
    @Body() dto: VoteReportDto,
  ): Promise<ReportView> {
    return this.reportsService.vote(user.id, reportId, dto.vote);
  }

  /** Admin-only takedown (build plan §16/§17). */
  @Post(':id/remove')
  @UseGuards(AdminGuard)
  removeReport(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', reportIdPipe) reportId: string,
    @Body() dto: RemoveReportDto,
  ): Promise<ReportView> {
    return this.reportsService.removeReport(admin.id, reportId, dto.reason);
  }

  /**
   * OWNER-ONLY self-retraction — "I filed this and I'm taking it back".
   *
   * A sibling of `:id/remove`, not a relaxation of it: that route keeps its
   * AdminGuard and its meaning (a moderator taking somebody else's report down).
   * POST rather than DELETE because nothing is deleted — the row survives with
   * its removal audit, exactly as a takedown leaves it — and because every other
   * state transition in this API (`/vote`, `/remove`, `/sos/:id/retract`,
   * `/trips/:id/cancel`) is a POSTed verb. No body: a reporter withdrawing their
   * own report owes nobody an explanation, and the reason is not forwarded
   * anywhere.
   */
  @Post(':id/retract')
  retractReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', reportIdPipe) reportId: string,
  ): Promise<ReportView> {
    return this.reportsService.retractReport(user.id, reportId);
  }

  @Get()
  findByBbox(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FindReportsQueryDto,
  ): Promise<ReportView[]> {
    return this.reportsService.findByBbox(user.id, query.bbox, query.types);
  }

  /** Declared before ':id' so 'near' is not swallowed by the param route. */
  @Get('near')
  findNear(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FindNearQueryDto,
  ): Promise<ReportView[]> {
    return this.reportsService.findNear(
      user.id,
      query.lat,
      query.lng,
      query.radiusM,
      query.types,
    );
  }

  @Get(':id')
  getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', reportIdPipe) reportId: string,
  ): Promise<ReportView> {
    return this.reportsService.getById(user.id, reportId);
  }
}
