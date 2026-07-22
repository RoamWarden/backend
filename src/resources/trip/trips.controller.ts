import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { AddPointsDto } from './dto/add-points.dto';
import { CreateTripDto } from './dto/create-trip.dto';
import { ListTripsQueryDto } from './dto/list-trips.query.dto';
import { LiveViewQueryDto } from './dto/live-view.query.dto';
import { StopTripDto } from './dto/stop-trip.dto';
import { TripsService } from './trips.service';

/** Rejects malformed trip ids before they reach Prisma/raw SQL. */
const tripIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      'Trip id must be a valid UUID — check the URL and try again.',
    ),
});

@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Post()
  createTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTripDto,
  ): ReturnType<TripsService['createTrip']> {
    return this.trips.createTrip(user, dto);
  }

  @Get()
  listTrips(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTripsQueryDto,
  ): ReturnType<TripsService['listTrips']> {
    return this.trips.listTrips(user.id, query);
  }

  @Get(':id')
  getTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', tripIdPipe) id: string,
  ): ReturnType<TripsService['getTrip']> {
    return this.trips.getTrip(user.id, id);
  }

  /**
   * Public live view for trusted contacts: authorized by a trip share token
   * (?token=) OR a Bearer JWT of the owner / a linked watcher (verified
   * manually because the global guard is skipped here).
   */
  @Public()
  @Get(':id/live')
  getLiveView(
    @Param('id', tripIdPipe) id: string,
    @Query() query: LiveViewQueryDto,
    @Headers('authorization') authorization?: string,
  ): ReturnType<TripsService['getLiveView']> {
    return this.trips.getLiveView(id, query.token, authorization);
  }

  @Post(':id/points')
  @HttpCode(HttpStatus.OK)
  addPoints(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', tripIdPipe) id: string,
    @Body() dto: AddPointsDto,
  ): ReturnType<TripsService['addPoints']> {
    return this.trips.addPoints(user, id, dto);
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  stopTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', tripIdPipe) id: string,
    @Body() dto: StopTripDto,
  ): ReturnType<TripsService['stopTrip']> {
    return this.trips.stopTrip(user, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', tripIdPipe) id: string,
  ): ReturnType<TripsService['cancelTrip']> {
    return this.trips.cancelTrip(user, id);
  }

  @Post(':id/share')
  @HttpCode(HttpStatus.OK)
  reissueShareToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', tripIdPipe) id: string,
  ): ReturnType<TripsService['reissueShareToken']> {
    return this.trips.reissueShareToken(user, id);
  }

  /** "I'm OK" response to an overdue/stall nudge — resets the escalation ladder. */
  @Post(':id/checkin')
  @HttpCode(HttpStatus.OK)
  checkin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', tripIdPipe) id: string,
  ): ReturnType<TripsService['checkin']> {
    return this.trips.checkin(user, id);
  }

  /** GDPR delete-trip-history: permanently removes the trip (owner only). */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', tripIdPipe) id: string,
  ): ReturnType<TripsService['deleteTrip']> {
    return this.trips.deleteTrip(user, id);
  }
}
