import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class RaiseSosDto {
  /** Attach the SOS to a specific trip; omit to use your current active trip. */
  @IsOptional()
  @IsUUID('all', {
    message:
      'tripId must be a valid UUID — omit it to attach the SOS to your current active trip.',
  })
  tripId?: string;

  @IsOptional()
  @IsNumber({}, { message: 'lat must be a number' })
  @Min(-90, { message: 'lat must be between -90 and 90' })
  @Max(90, { message: 'lat must be between -90 and 90' })
  lat?: number;

  @IsOptional()
  @IsNumber({}, { message: 'lng must be a number' })
  @Min(-180, { message: 'lng must be between -180 and 180' })
  @Max(180, { message: 'lng must be between -180 and 180' })
  lng?: number;

  @IsOptional()
  @IsString({ message: 'message must be text' })
  @MaxLength(300, { message: 'message must be at most 300 characters' })
  message?: string;
}
