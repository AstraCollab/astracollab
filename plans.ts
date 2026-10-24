import { plan } from "atmn";

/**
 * AI credits.
 *
 * `ai-credits-5` is a template, not a fixed bundle: the purchase API overrides
 * both the price and the token grant per checkout, so any whole-dollar amount
 * from $5 works without a plan per denomination.
 */
export const plans = [
  // Free plan — auto-enabled on customer creation
  plan({
    internalId: "prod_3L7qgHVGbRHamTAZJ9hdPMxrfFL",
    planId: "free",
    versionSlug: "v1",
    active: true,
    name: "Free",
    autoEnable: true,
    price: { amount: 0, interval: "month" },
    items: [
      { featureId: "compute", included: 300000, reset: { interval: "month" } }, // 5 min compute
      { featureId: "storage", included: 5000000000 }, // 5GB
    ],
  }),

  // Pay As You Go — default paid plan
  plan({
    internalId: "prod_3L7qgJFyBVglMr5fgWJd3MiRbVn",
    planId: "pay-as-you-go",
    versionSlug: "v1",
    active: true,
    name: "Pay As You Go",
    description: "Launch cloud agents on demand. Pay only when sandboxes run.",
    price: { amount: 0, interval: "month" },
    items: [
      {
        featureId: "compute",
        included: 0,
        reset: { interval: "month" },
        price: {
          amount: 0.04,
          billingUnits: 3600, // $0.04 per hour = per 3600 seconds
          interval: "month",
          billingMethod: "usage_based" as const,
        },
      },
      { featureId: "storage", included: 100000000000 }, // 100GB
    ],
  }),

  // Always-on — add-on plan
  plan({
    internalId: "prod_3L7qgNQof2IUpq9rVT27SlKqfyN",
    planId: "always-on",
    versionSlug: "v1",
    active: true,
    name: "Always-On",
    description: "Persistent 24/7 sandbox with workspace sharing",
    addOn: true,
    price: { amount: 28, interval: "month" },
    items: [
      { featureId: "always-on", included: 1 },
      {
        featureId: "compute",
        included: 864000000, // 24h of compute in millicpu-seconds
        reset: { interval: "month" },
      },
    ],
  }),

  // AI Credits — one-off prepaid token purchase. Runs that do not bring their
  // own provider key use Nah's OpenRouter key and draw from this balance.
  plan({
    internalId: "prod_3L9CK6V8cmBQrrg2BIRXFbLeVwf",
    planId: "ai-credits-5",
    versionSlug: "v1",
    active: true,
    name: "AI Credits",
    description: "Prepaid AI tokens. Minimum purchase is $5.",
    price: { amount: 5, interval: "one_off" },
    items: [{ featureId: "tokens", included: 50000 }],
  }),
];
