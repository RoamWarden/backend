import { Transform, Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class SearchPlacesQueryDto {
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'q query param must be a string.' })
  @MinLength(2, { message: 'q must be at least 2 characters.' })
  @MaxLength(120, { message: 'q must be at most 120 characters.' })
  q!: string;

  /** Optional bias point — must be sent together with lng to take effect. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    {},
    { message: 'lat query param must be a number (WGS84 latitude).' },
  )
  @Min(-90, { message: 'lat must be between -90 and 90.' })
  @Max(90, { message: 'lat must be between -90 and 90.' })
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    {},
    { message: 'lng query param must be a number (WGS84 longitude).' },
  )
  @Min(-180, { message: 'lng must be between -180 and 180.' })
  @Max(180, { message: 'lng must be between -180 and 180.' })
  lng?: number;
}
