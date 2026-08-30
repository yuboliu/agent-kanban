import type { AppServices } from "./types";

export interface MachineMetrics {
  machine_id: string;
  qps: number;
  error_rate: number;
  avg_latency_ms: number;
  total_requests: number;
}

const WINDOW_SECONDS = 300;

/**
 * Pure-local metrics: reads the in-process rolling window (stage 2 replaced
 * the Cloudflare Analytics Engine query with an in-memory provider).
 */
export async function getMachineMetrics(env: AppServices): Promise<Map<string, MachineMetrics>> {
  const rows = await env.metricsProvider.queryMachineMetrics(WINDOW_SECONDS);
  const map = new Map<string, MachineMetrics>();
  for (const row of rows.values()) {
    map.set(row.machine_id, {
      machine_id: row.machine_id,
      qps: Math.round((row.total_requests / WINDOW_SECONDS) * 100) / 100,
      error_rate: row.total_requests > 0 ? Math.round((row.error_requests / row.total_requests) * 1000) / 10 : 0,
      avg_latency_ms: Math.round(row.avg_latency),
      total_requests: row.total_requests,
    });
  }
  return map;
}
