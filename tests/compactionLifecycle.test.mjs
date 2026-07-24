import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

function blockBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("manual compaction sends Pi's customInstructions field and always clears local tracking", () => {
  const compactBlock = blockBetween(
    mainSource,
    "async compact(agentId: string, prompt?: string)",
    "private async reattachProcess",
  );

  assert.match(compactBlock, /customInstructions/);
  assert.doesNotMatch(compactBlock, /type: "compact", prompt:/);
  assert.match(compactBlock, /finally\s*\{[\s\S]*compactingAgents\.delete\(agentId\)/);
});

test("manual compaction does not rely on a later agent_settled event to become idle", () => {
  const eventBlock = blockBetween(
    mainSource,
    'if (typed.type === "compaction_end")',
    'if (typed.type === "agent_end")',
  );

  assert.match(eventBlock, /isManualCompaction/);
  assert.match(eventBlock, /compact\(\) finally/);
});

test("renderer treats compaction as busy even when Pi has not set isStreaming", () => {
  const busyBlock = blockBetween(
    appSource,
    "const isAgentBusy = Boolean(",
    "// 切换 agent 时不能沿用",
  );

  assert.match(busyBlock, /activeRuntimeState\?\.isCompacting/);
});
