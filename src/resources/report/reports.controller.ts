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

  @Get()
  findByBbox(@Query() query: FindReportsQueryDto): Promise<ReportView[]> {
    return this.reportsService.findByBbox(query.bbox, query.types);
  }

  /** Declared before ':id' so 'near' is not swallowed by the param route. */
  @Get('near')
  findNear(@Query() query: FindNearQueryDto): Promise<ReportView[]> {
    return this.reportsService.findNear(
      query.lat,
      query.lng,
      query.radiusM,
      query.types,
    );
  }

  @Get(':id')
  getById(@Param('id', reportIdPipe) reportId: string): Promise<ReportView> {
    return this.reportsService.getById(reportId);
  }
}
