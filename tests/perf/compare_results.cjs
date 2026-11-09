const fs = require("fs");
const path = require("path");

const bFile = path.join(
  process.cwd(),
  "performance-results/v1.0.6/baseline_active_8min.json",
);
const oFile = path.join(
  process.cwd(),
  "performance-results/v1.0.6/optimized_active_8min.json",
);

const b = JSON.parse(fs.readFileSync(bFile, "utf8"));
const o = JSON.parse(fs.readFileSync(oFile, "utf8"));

console.log(
  "| Milestone | Metric | Baseline v1.0.5 | Optimized v1.0.6 | Delta / Improvement |",
);
console.log("|---|---|---|---|---|");

const mins = [0, 1, 3, 5, 7];
for (const m of mins) {
  const targetSec = m * 60;
  const be = b.reduce((prev, curr) =>
    Math.abs(curr.elapsedSec - targetSec) <
    Math.abs(prev.elapsedSec - targetSec)
      ? curr
      : prev,
  );
  const oe = o.reduce((prev, curr) =>
    Math.abs(curr.elapsedSec - targetSec) <
    Math.abs(prev.elapsedSec - targetSec)
      ? curr
      : prev,
  );

  const heapDelta = (
    ((oe.heapUsedMB - be.heapUsedMB) / be.heapUsedMB) *
    100
  ).toFixed(1);
  const p95Delta = (
    ((oe.p95FrameMs - be.p95FrameMs) / be.p95FrameMs) *
    100
  ).toFixed(1);

  console.log(
    `| **${m}m** (${oe.units} units) | JS Heap Used | ${be.heapUsedMB} MB | ${oe.heapUsedMB} MB | **${oe.heapUsedMB < be.heapUsedMB ? "-" : "+"}${Math.abs(heapDelta)}%** |`,
  );
  console.log(
    `| | p95 Frame Time | ${be.p95FrameMs} ms | ${oe.p95FrameMs} ms | **${oe.p95FrameMs < be.p95FrameMs ? "-" : "+"}${Math.abs(p95Delta)}%** |`,
  );
  console.log(
    `| | 1% Low FPS | ${be.low1pct} FPS | ${oe.low1pct} FPS | **${(oe.low1pct - be.low1pct).toFixed(1)} FPS** |`,
  );
}

// Average across entire run
const bAvgHeap = (
  b.reduce((acc, c) => acc + c.heapUsedMB, 0) / b.length
).toFixed(1);
const oAvgHeap = (
  o.reduce((acc, c) => acc + c.heapUsedMB, 0) / o.length
).toFixed(1);
const bMaxHeap = Math.max(...b.map((c) => c.heapUsedMB)).toFixed(1);
const oMaxHeap = Math.max(...o.map((c) => c.heapUsedMB)).toFixed(1);

console.log("\n--- Overall Run Summary ---");
console.log(
  `Baseline Average Heap: ${bAvgHeap} MB | Max Peak Heap: ${bMaxHeap} MB`,
);
console.log(
  `Optimized Average Heap: ${oAvgHeap} MB | Max Peak Heap: ${oMaxHeap} MB`,
);
