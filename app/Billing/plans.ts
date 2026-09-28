/**
 * Uplink's plans: one list, read by `config/saas.ts` (what `buddy stripe:setup`
 * creates in Stripe), the pricing page, and checkout. Prices are integer cents.
 *
 * Every plan is the whole app. They differ only in how you pay.
 */

export type PlanId = 'monthly' | 'yearly' | 'lifetime'

export interface Plan {
  id: PlanId
  name: string
  /** Stripe `lookup_key`: how checkout finds the price without an id in code. */
  lookupKey: string
  /** Minor units: 199 is $1.99. */
  priceCents: number
  /** Recurring interval; none means a one-time payment. */
  interval?: 'month' | 'year'
  /** Under the price: what the number means. */
  cadence: string
  blurb: string
}

export const PRODUCT_NAME = 'Uplink'

export const PLANS: Plan[] = [
  {
    id: 'monthly',
    name: 'Monthly',
    lookupKey: 'uplink_monthly',
    priceCents: 199,
    interval: 'month',
    cadence: 'a month',
    blurb: 'Month to month, for a trip or two.',
  },
  {
    id: 'yearly',
    name: 'Yearly',
    lookupKey: 'uplink_yearly',
    priceCents: 1999,
    interval: 'year',
    cadence: 'a year',
    blurb: 'A year of texting your Mac from anywhere.',
  },
  {
    id: 'lifetime',
    name: 'Lifetime',
    lookupKey: 'uplink_lifetime',
    priceCents: 2999,
    cadence: 'once',
    blurb: 'Pay once, keep it, with every update.',
  },
]

export function planById(id: unknown): Plan | undefined {
  return PLANS.find(plan => plan.id === id)
}

/** "$1.99". Cents in, a display string out, at the last moment. */
export function formatCents(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)
}

/**
 * What yearly saves over twelve months of monthly, as a whole percentage
 * rounded down, so the claim is never larger than the truth.
 */
export function yearlySavingPercent(plans: Plan[] = PLANS): number {
  const monthly = plans.find(plan => plan.id === 'monthly')
  const yearly = plans.find(plan => plan.id === 'yearly')
  if (!monthly || !yearly)
    return 0
  return Math.floor((1 - yearly.priceCents / (monthly.priceCents * 12)) * 100)
}
