import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDate,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TRIP_POINTS_MAX_BATCH } from '../../../common/constants';

export class TripPointDto {
  @IsNumber({}, { message: 'lat must be a number' })
  @Min(-90, { message: 'lat must be between -90 and 90' })
  @Max(90, { message: 'lat must be between -90 and 90' })
  lat!: number;

  @IsNumber({}, { message: 'lng must be a number' })
  @Min(-180, { message: 'lng must be between -180 and 180' })
  @Max(180, { message: 'lng must be between -180 and 180' })
  lng!: number;

  @IsOptional()
  @IsNumber({}, { message: 'speed must be a number (m/s)' })
  speed?: number;

  @IsOptional()
  @IsNumber({}, { message: 'heading must be a number (degrees)' })
  heading?: number;

  @IsOptional()
  @IsNumber({}, { message: 'accuracy must be a number (metres)' })
  accuracy?: number;

  @Type(() => Date)
  @IsDate({
    message:
      'recordedAt must be a valid ISO 8601 date string (e.g. 2026-07-21T09:30:00Z)',
  })
  recordedAt!: Date;
}

export class AddPointsDto {
  @IsArray({ message: 'points must be an array of breadcrumbs' })
  @ArrayNotEmpty({ message: 'points must contain at least one breadcrumb' })
  @ArrayMaxSize(TRIP_POINTS_MAX_BATCH, {
    message: `points can contain at most ${TRIP_POINTS_MAX_BATCH} entries per batch — split larger uploads into smaller batches`,
  })
  @ValidateNested({ each: true })
  @Type(() => TripPointDto)
  points!: TripPointDto[];
}
