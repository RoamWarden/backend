import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for POST /waitlist — a landing-page early-access signup. */
export class JoinWaitlistDto {
  @IsEmail({}, { message: 'Please provide a valid email address.' })
  email!: string;

  /** Where the signup came from (e.g. a landing-page section or campaign). */
  @IsOptional()
  @IsString({ message: 'source must be a string.' })
  @MaxLength(100, { message: 'source must be at most 100 characters.' })
  source?: string;
}
