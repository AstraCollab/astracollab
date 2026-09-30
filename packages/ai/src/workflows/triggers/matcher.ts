export type ActivityTriggerEvent = {
  orgId: string;
  activityType: string;
  entityType: string;
  entityId: string;
  projectId?: string | null;
  ticketId?: string | null;
  teamId?: string | null;
  channelId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type WorkflowTriggerRule = {
  id: string;
  workflowId: string;
  enabled: boolean;
  activityType?: string | null;
  entityType?: string | null;
  filters?: Record<string, unknown> | null;
};

const matchesFilter = (
  filters: Record<string, unknown> | null | undefined,
  event: ActivityTriggerEvent,
): boolean => {
  if (!filters || Object.keys(filters).length === 0) return true;

  for (const [key, expected] of Object.entries(filters)) {
    const actual =
      key in event
        ? (event as Record<string, unknown>)[key]
        : event.metadata?.[key];
    if (expected === undefined || expected === null) continue;
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
};

export const matchTriggers = (
  event: ActivityTriggerEvent,
  rules: WorkflowTriggerRule[],
): WorkflowTriggerRule[] =>
  rules.filter((rule) => {
    if (!rule.enabled) return false;
    if (rule.activityType && rule.activityType !== event.activityType) return false;
    if (rule.entityType && rule.entityType !== event.entityType) return false;
    return matchesFilter(rule.filters ?? null, event);
  });
