import test from "node:test";
import assert from "node:assert/strict";
import { downsampleMetrics } from "../src/metrics.mjs";

test("verdichtet Diagrammdaten und bewahrt markante Latenzspitzen", () => {
  const points = Array.from({ length: 300 }, (_, index) => ({ latencyMs: index === 177 ? 9_999 : 10 + index % 25, checkedAt: String(index) }));
  const compact = downsampleMetrics(points, 120);
  assert.ok(compact.length <= 120);
  assert.equal(compact[0].checkedAt, "0");
  assert.equal(compact.at(-1).checkedAt, "299");
  assert.equal(compact.some((point) => point.latencyMs === 9_999), true);
});

test("ändert kurze Diagrammreihen nicht", () => {
  const points = [{ latencyMs: 10 }, { latencyMs: 11 }];
  assert.deepEqual(downsampleMetrics(points, 120), points);
});
