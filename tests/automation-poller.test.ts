// @vitest-environment node

import { describe, expect, it } from "vitest";
import { clampPollInterval, shouldSkipPoll } from "../packages/cli/src/daemon/githubAutomationPoller";

describe("githubAutomationPoller poll-interval helpers", () => {
  describe("clampPollInterval", () => {
    it("defaults to 60 when input is missing or non-numeric", () => {
      expect(clampPollInterval(undefined)).toBe(60);
      expect(clampPollInterval(null)).toBe(60);
      expect(clampPollInterval("not-a-number")).toBe(60);
    });

    it("accepts values inside the [30, 86400] band unchanged", () => {
      expect(clampPollInterval(30)).toBe(30);
      expect(clampPollInterval(300)).toBe(300);
      expect(clampPollInterval(3600)).toBe(3600);
      expect(clampPollInterval(86_400)).toBe(86_400);
    });

    it("floors values below 30 to 30 and caps above 86400 to 86400", () => {
      expect(clampPollInterval(0)).toBe(30);
      expect(clampPollInterval(29)).toBe(30);
      expect(clampPollInterval(86_401)).toBe(86_400);
      expect(clampPollInterval(999_999)).toBe(86_400);
    });

    it("coerces numeric strings", () => {
      expect(clampPollInterval("120")).toBe(120);
    });
  });

  describe("shouldSkipPoll", () => {
    const NOW = Date.parse("2026-09-01T12:00:00.000Z");

    it("does not skip when the automation has never been processed", () => {
      expect(shouldSkipPoll(NOW, null, 60)).toBe(false);
    });

    it("does not skip when last_processed_at is unparseable", () => {
      expect(shouldSkipPoll(NOW, "not-a-date", 60)).toBe(false);
    });

    it("skips when last_processed_at is within the configured interval", () => {
      const last = new Date(NOW - 30_000).toISOString();
      expect(shouldSkipPoll(NOW, last, 60)).toBe(true);
    });

    it("does not skip when last_processed_at is older than the interval", () => {
      const last = new Date(NOW - 120_000).toISOString();
      expect(shouldSkipPoll(NOW, last, 60)).toBe(false);
    });

    it("honours the per-automation interval rather than the global tick", () => {
      const last = new Date(NOW - 600_000).toISOString();
      // 600s ago, but user configured a 1h interval → must skip.
      expect(shouldSkipPoll(NOW, last, 3600)).toBe(true);
      // Same instant, but a 5min interval → must proceed.
      expect(shouldSkipPoll(NOW, last, 300)).toBe(false);
    });
  });
});
