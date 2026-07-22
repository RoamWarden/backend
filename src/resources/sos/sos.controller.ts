import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { RaiseSosDto } from './dto/raise-sos.dto';
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
}
