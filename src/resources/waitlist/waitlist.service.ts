import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../providers/mail/mail.service';
import {
  WAITLIST_DEFAULT_LIMIT,
  WAITLIST_DEFAULT_PAGE,
  WAITLIST_MAX_LIMIT,
} from './constant/waitlist.constants';
import type {
  JoinWaitlistResult,
  WaitlistListResult,
} from './type/waitlist.types';

/**
 * Early-access waitlist. Public join (idempotent on email), admin listing, and
 * a public social-proof count. Confirmation email is best-effort and never
 * allowed to fail the join request.
 */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /**
   * Adds an email to the waitlist. Re-joining an already-listed email is a
   * success (alreadyJoined:true) and does NOT re-send the confirmation.
   */
  async join(input: {
    email: string;
    source?: string;
  }): Promise<JoinWaitlistResult> {
    const email = input.email.trim().toLowerCase();
    const source = input.source?.trim() || null;

    try {
      await this.prisma.waitlistEntry.create({
        data: { email, source },
      });
    } catch (error) {
      if (this.isPrismaError(error, 'P2002')) {
        // Already on the list — treat as success, no duplicate confirmation.
        return { joined: true, alreadyJoined: true };
      }
      throw error;
    }

    // Best-effort confirmation. MailService never throws, but guard anyway so
    // an unexpected rejection can never fail the join. Not awaited-to-throw.
    void this.mail.sendWaitlistConfirmation(email).catch((err: unknown) => {
      this.logger.error(
        `Failed to send waitlist confirmation to ${email}`,
        err instanceof Error ? err.stack : String(err),
      );
    });

    return { joined: true, alreadyJoined: false };
  }

  /** Admin: paginated listing of waitlist entries, newest first. */
  async list(input: {
    page?: number;
    limit?: number;
  }): Promise<WaitlistListResult> {
    const page = input.page ?? WAITLIST_DEFAULT_PAGE;
    const limit = Math.min(
      input.limit ?? WAITLIST_DEFAULT_LIMIT,
      WAITLIST_MAX_LIMIT,
    );
    const skip = (page - 1) * limit;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.waitlistEntry.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, email: true, source: true, createdAt: true },
      }),
      this.prisma.waitlistEntry.count(),
    ]);

    return { entries: rows, total, page, limit };
  }

  /** Public social-proof count of everyone on the waitlist. */
  async count(): Promise<number> {
    return this.prisma.waitlistEntry.count();
  }

  private isPrismaError(error: unknown, code: string): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === code
    );
  }
}
