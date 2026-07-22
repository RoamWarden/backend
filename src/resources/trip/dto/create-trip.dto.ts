import { Type } from 'class-transformer';
import {
  IsArray,
  IsDefined,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TransportMode } from '@prisma/client';

export class TripEndpointDto {
  @IsNumber({}, { message: 'lat must be a number' })
  @Min(-90, { message: 'lat must be between -90 and 90' })
  @Max(90, { message: 'lat must be between -90 and 90' })
  lat!: number;

  @IsNumber({}, { message: 'lng must be a number' })
  @Min(-180, { message: 'lng must be between -180 and 180' })
  @Max(180, { message: 'lng must be between -180 and 180' })
  lng!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'label must be at most 200 characters' })
  label?: string;
}

export class CreateTripDto {
  @IsEnum(TransportMode, {
    message: `mode must be one of: ${Object.values(TransportMode).join(', ')}`,
  })
  mode!: TransportMode;

  @IsDefined({ message: 'origin is required ({ lat, lng, label? })' })
  @IsObject({ message: 'origin must be an object ({ lat, lng, label? })' })
  @ValidateNested()
  @Type(() => TripEndpointDto)
  origin!: TripEndpointDto;

  @IsDefined({ message: 'destination is required ({ lat, lng, label? })' })
  @IsObject({ message: 'destination must be an object ({ lat, lng, label? })' })
  @ValidateNested()
  @Type(() => TripEndpointDto)
  destination!: TripEndpointDto;

  @IsOptional()
  @IsArray({ message: 'watcherContactIds must be an array of contact ids' })
  @IsUUID('all', {
    each: true,
    message: 'each watcherContactIds entry must be a valid UUID',
  })
  watcherContactIds?: string[];

  @IsOptional()
  @IsInt({ message: 'expectedDurationS must be a whole number of seconds' })
  @Min(1, { message: 'expectedDurationS must be at least 1 second' })
  expectedDurationS?: number;
}
