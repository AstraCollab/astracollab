import { feature } from "atmn";

export const features = [
  feature({
    internalId: "fe_3L7qgKR7GogiT3RPlVmKoUwEy4d",
    featureId: "compute",
    name: "Compute",
    type: "metered",
    consumable: true,
  }),

  feature({
    internalId: "fe_3L7qgLF4xGPLXD9E1ITqgcgTtiw",
    featureId: "storage",
    name: "Storage",
    type: "metered",
    consumable: false,
  }),

  feature({
    internalId: "fe_3L7qgMgPgFvP9kgehmGkQfqiXSQ",
    featureId: "always-on",
    name: "Always-On",
    type: "boolean",
    consumable: false,
  }),

  // AI Tokens — prepaid, metered units consumed by hosted agents.
  // 1 token = 1 model token. Bundles are on the `ai-credits-*` plans.
  feature({
    internalId: "fe_3L7qgJLhu8W4S9cXPdV7uSMPGQC",
    featureId: "tokens",
    name: "AI Tokens",
    type: "metered",
    consumable: true,
  }),
];
