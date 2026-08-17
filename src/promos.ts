import type { AppConfig } from './config';

const SPARK_PAY_URL = process.env.SPARK_PAY_URL || 'https://sparkpay.dev';

export interface Coupon {
  code: string;
  discountPercent: number;
  description: string | null;
  expiresAt: string | null;
  appliesToTiers: string[] | null;
}

/**
 * Currently active, publicly listed coupons for an app.
 *
 * Deliberately the public endpoint rather than the admin/MCP surface: it
 * filters on `listed` server-side, so codes that are not meant for a public
 * channel -- the 100%-off creator seeding codes, private partner deals --
 * cannot reach a Discord post even if this code is wrong about which are safe.
 * That filter belongs on the side that owns the data, not here.
 */
export async function fetchListedCoupons(config: AppConfig): Promise<Coupon[]> {
  const appId = config.app.spark_pay_app_id;
  if (!appId) return [];

  try {
    const res = await fetch(
      `${SPARK_PAY_URL}/api/public/coupons/list?app_id=${encodeURIComponent(appId)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) {
      console.error(`[promos:${config.app.name}] coupons/list -> ${res.status}`);
      return [];
    }
    const body = await res.json();
    return Array.isArray(body.coupons) ? body.coupons : [];
  } catch (err) {
    console.error(`[promos:${config.app.name}] coupon fetch failed:`, err);
    return [];
  }
}

/** Human-readable days left, or null if the coupon never expires. */
function daysLeft(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86400000));
}

/**
 * A one-line post for a coupon. Plain and factual -- the code, what it takes
 * off, and how long it lasts is the whole of what somebody needs, and Alex
 * reading like an ad is the fastest way to get muted.
 */
export function couponLine(config: AppConfig, coupon: Coupon): string {
  const left = daysLeft(coupon.expiresAt);
  const parts = [`\`${coupon.code}\` takes ${coupon.discountPercent}% off ${config.app.name}`];

  if (coupon.appliesToTiers?.length) {
    parts.push(`on the ${coupon.appliesToTiers.join(' and ')} tier`);
  }
  if (left !== null) {
    parts.push(left === 0 ? '-- expires today' : left === 1 ? '-- last day' : `-- ${left} days left`);
  }
  return `${parts.join(' ')}. ${config.app.url}`;
}
