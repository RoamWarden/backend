import { Type } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';

export class NearbyPlacesQueryDto {
  @Type(() => Number)
  @IsNumber(
    {},
    { message: 'lat query param must be a number (WGS84 latitude).' },
  )
  @Min(-90, { message: 'lat must be between -90 and 90.' })
  @Max(90, { message: 'lat must be between -90 and 90.' })
  lat!: number;

  @Type(() => Number)
  @IsNumber(
    {},
    { message: 'lng query param must be a number (WGS84 longitude).' },
  )
  @Min(-180, { message: 'lng must be between -180 and 180.' })
  @Max(180, { message: 'lng must be between -180 and 180.' })
  lng!: number;
}
