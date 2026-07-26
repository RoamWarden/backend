import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Withdrawing an SOS. The reason is optional and never demanded: someone
 * cancelling a false alarm should not have to fill in a form to stop their
 * contacts worrying. When it IS given it is forwarded verbatim to exactly the
 * contacts the original alert reached, so keep it short enough to survive a
 * push notification.
 */
export class RetractSosDto {
  @IsOptional()
  @IsString({ message: 'reason must be text' })
  @MaxLength(200, { message: 'reason must be at most 200 characters' })
  reason?: string;
}
