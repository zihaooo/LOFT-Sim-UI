import type { FlowDefinition } from "../types";

/** Parses the demand JSON file into FlowDefinition records, coercing snake_case keys to the internal shape. */
export function parseFlowDefinitions(rawJson?: string): FlowDefinition[] {
  const trimmed = rawJson?.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as unknown;
  const raw = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];

  return raw.map((flow) => ({
    flowId: String(flow.flow_id ?? ""),
    routeId: String(flow.air_route_id ?? ""),
    uavPerHour: Number(flow.uav_per_hour ?? 0),
  }));
}
