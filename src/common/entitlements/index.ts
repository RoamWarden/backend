/**
 * Plan entitlements — the single import path for every other module:
 *
 *   import { EntitlementsService } from '../../common/entitlements';
 *   import type { LimitCheck } from '../../common/entitlements';
 *
 * EntitlementsModule is @Global, so no module import is needed to inject the
 * service.
 */
export * from './entitlement.constants';
export * from './entitlement.types';
export * from './entitlements.module';
export * from './entitlements.service';
