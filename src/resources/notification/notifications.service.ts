import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEAD_TOKEN_ERROR_CODES,
  FCM_MULTICAST_MAX_TOKENS,
} from './constant/notifications.constants';
import type { PushMessage } from './type/notifications.types';

/**
 * Firebase Admin FCM wrapper. Looks up device tokens itself, chunks sends to
 * ≤500 tokens, prunes dead tokens, and NEVER throws — push delivery is
 * best-effort and must not break the calling flow (alerts/trips/sos).
 *
 * When FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are
 * not all configured, one warning is logged at boot and sendToUsers becomes a
 * debug-logged no-op.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private app: App | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (this.app) {
      // Guard against double initialization (initializeApp throws if the
      // default app already exists).
      return;
    }

    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    // .env files typically store the key with literal "\n" sequences.
    const privateKey = this.config
      .get<string>('FIREBASE_PRIVATE_KEY')
      ?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Push notifications DISABLED — FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY not fully configured',
      );
      return;
    }

    try {
      this.app = initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
      });
      this.logger.log('Push notifications enabled (FCM)');
    } catch (err) {
      // Malformed credentials (e.g. a truncated private key) must not crash
      // the API — push stays disabled and the operator gets a clear pointer.
      this.app = null;
      this.logger.error(
        'Push notifications DISABLED — Firebase Admin initialization failed. Check the FIREBASE_* values in backend/.env (the private key must keep its BEGIN/END lines).',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Sends a push notification to every registered device of the given users.
   * Looks up device tokens itself; chunks ≤500; prunes dead tokens; never
   * throws (logs instead).
   */
  async sendToUsers(userIds: string[], msg: PushMessage): Promise<void> {
    try {
      if (userIds.length === 0) return;
      if (!this.app) {
        this.logger.debug(
          `Push disabled — skipping notification "${msg.title}" for ${userIds.length} user(s)`,
        );
        return;
      }

      const devices = await this.prisma.deviceToken.findMany({
        where: { userId: { in: userIds } },
        select: { token: true },
      });
      if (devices.length === 0) {
        this.logger.debug(
          `No device tokens registered for ${userIds.length} user(s) — nothing to push`,
        );
        return;
      }

      const tokens = devices.map((d) => d.token);
      const data = this.coerceData(msg.data);
      const messaging = getMessaging(this.app);

      let sent = 0;
      let failed = 0;
      const deadTokens: string[] = [];

      for (const chunk of this.chunk(tokens, FCM_MULTICAST_MAX_TOKENS)) {
        try {
          const result = await messaging.sendEachForMulticast({
            tokens: chunk,
            notification: { title: msg.title, body: msg.body },
            ...(data ? { data } : {}),
          });
          sent += result.successCount;
          failed += result.failureCount;
          result.responses.forEach((response, i) => {
            if (response.success) return;
            const code = response.error?.code;
            if (code && DEAD_TOKEN_ERROR_CODES.has(code)) {
              deadTokens.push(chunk[i]);
            }
          });
        } catch (err) {
          // A whole-batch failure (network, auth) — count the chunk as failed
          // and keep going with the remaining chunks.
          failed += chunk.length;
          this.logger.error(
            `FCM multicast batch of ${chunk.length} token(s) failed for notification "${msg.title}"`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }

      if (deadTokens.length > 0) {
        const { count } = await this.prisma.deviceToken.deleteMany({
          where: { token: { in: deadTokens } },
        });
        this.logger.log(`Pruned ${count} dead device token(s)`);
      }

      this.logger.log(
        `Push "${msg.title}": sent ${sent}, failed ${failed} (${tokens.length} token(s), ${userIds.length} user(s))`,
      );
    } catch (err) {
      // Contract: never throw — push failures must not break alert/trip/sos flows.
      this.logger.error(
        `Unexpected error sending push notification "${msg.title}" to ${userIds.length} user(s)`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** FCM requires every data value to be a string — coerce defensively. */
  private coerceData(
    data?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!data) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = String(value);
    }
    return out;
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }
}
