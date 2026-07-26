import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { RaiseSosDto } from './dto/raise-sos.dto';
import { RetractSosDto } from './dto/retract-sos.dto';
import { SosService } from './sos.service';

/** Rejects malformed SOS event ids before they reach Prisma. */
const sosIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      'SOS event id must be a valid UUID — check the URL and try again.',
    ),
});

@Controller('sos')
export class SosController {
  constructor(private readonly sos: SosService) {}

  @Post()
  raise(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RaiseSosDto,
  ): ReturnType<SosService['raise']> {
    return this.sos.raise(user, dto);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', sosIdPipe) id: string,
  ): ReturnType<SosService['resolve']> {
    return this.sos.resolve(user, id);
  }

  /**
   * The traveller WITHDRAWS an alert (false alarm, pocket dial, scare passed).
   *
   * Separate from /resolve on purpose: /resolve says "I am safe now" about an
   * SOS that happened, this says "that should not have gone out". It stops the
   * escalation AND tells the contacts the alert actually reached to stand down,
   * and it costs the traveller a small, bounded amount of reputation.
   *
   * Idempotent — a second call returns the same answer instead of an error.
   */
  @Post(':id/retract')
  @HttpCode(HttpStatus.OK)
  retract(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', sosIdPipe) id: string,
    @Body() dto: RetractSosDto,
  ): ReturnType<SosService['retract']> {
    return this.sos.retract(user, id, dto);
  }

  /**
   * Called by a TRUSTED CONTACT, not the traveller: "I've seen this, I'm on
   * it." Stops the priority ladder paging further down the contact list. It
   * does not mark the traveller safe — only they can, via /resolve.
   */
  @Post(':id/ack')
  @HttpCode(HttpStatus.OK)
  acknowledge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', sosIdPipe) id: string,
  ): ReturnType<SosService['acknowledge']> {
    return this.sos.acknowledge(user, id);
  }

  /** The traveller's own audit trail: who we tried to reach, when, and how. */
  @Get(':id/trail')
  trail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', sosIdPipe) id: string,
  ): ReturnType<SosService['getTrail']> {
    return this.sos.getTrail(user, id);
  }
}
