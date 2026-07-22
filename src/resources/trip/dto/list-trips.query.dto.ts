import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { TripStatus } from '@prisma/client';

export class ListTripsQueryDto {
  @IsOptional()
  @IsEnum(TripStatus, {
    message: `status must be one of: ${Object.values(TripStatus).join(', ')}`,
  })
  status?: TripStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be a whole number' })
  @Min(1, { message: 'page must be at least 1' })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be a whole number' })
  @Min(1, { message: 'limit must be at least 1' })
  limit?: number;
}
