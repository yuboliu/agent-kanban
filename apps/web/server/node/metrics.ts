import type { MachineMetricsRow, MetricsQueryProvider, MetricsService } from "../types";

interface MetricPoint {
  machineId: string;
  status: number;
  latencyMs: number;
  t: number;
}

/**
 * In-process rolling metrics for the pure-local runtime. Replaces Cloudflare
 * Analytics Engine: writeDataPoint() feeds a 5-minute in-memory window and
 * queryMachineMetrics() aggregates it. Resets to zero on process restart.
 */
export function createInMemoryMetrics(options?: { retentionSeconds?: number }): {
  service: MetricsService;
  provider: MetricsQueryProvider;
  startPruning(): void;
  stop(): void;
} {
  const retentionSeconds = options?.retentionSeconds ?? 3600;
  const points: MetricPoint[] = [];
  let pruneTimer: NodeJS.Timeout | null = null;

  const prune = () => {
    const cutoff = Date.now() - retentionSeconds * 1000;
    while (points.length > 0 && points[0].t < cutoff) points.shift();
  };

  const service: MetricsService = {
    writeDataPoint(point) {
      const machineId = point.indexes?.[0];
      const [status, latencyMs] = point.doubles ?? [];
      if (!machineId || typeof status !== "number" || typeof latencyMs !== "number") return;
      points.push({ machineId, status, latencyMs, t: Date.now() });
    },
  };

  const provider: MetricsQueryProvider = {
    async queryMachineMetrics(windowSeconds) {
      prune();
      const cutoff = Date.now() - windowSeconds * 1000;
      const buckets = new Map<string, { total: number; errors: number; latencySum: number }>();
      for (const point of points) {
        if (point.t < cutoff) continue;
        const bucket = buckets.get(point.machineId) ?? { total: 0, errors: 0, latencySum: 0 };
        bucket.total += 1;
        if (point.status >= 400) bucket.errors += 1;
        bucket.latencySum += point.latencyMs;
        buckets.set(point.machineId, bucket);
      }
      const result = new Map<string, MachineMetricsRow>();
      for (const [machineId, bucket] of buckets) {
        result.set(machineId, {
          machine_id: machineId,
          total_requests: bucket.total,
          error_requests: bucket.errors,
          avg_latency: bucket.total > 0 ? bucket.latencySum / bucket.total : 0,
        });
      }
      return result;
    },
  };

  return {
    service,
    provider,
    startPruning() {
      if (pruneTimer) return;
      pruneTimer = setInterval(prune, 60_000);
      pruneTimer.unref?.();
    },
    stop() {
      if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
    },
  };
}
