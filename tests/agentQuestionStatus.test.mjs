import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync("src/renderer/src/agentQuestionStatus.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {}, Set };
	vm.runInNewContext(outputText, sandbox, {
		filename: "agentQuestionStatus.ts",
	});
	return sandbox.exports;
}

test("tracks pending interactive questions by agent without showing notices or completed requests", () => {
	const { getPendingQuestionAgentIds } = loadModule();
	const ids = getPendingQuestionAgentIds({
		select: { agentId: "agent-a", method: "select" },
		confirm: { agentId: "agent-b", method: "confirm" },
		input: { agentId: "agent-c", method: "input", completed: true },
		notify: { agentId: "agent-d", method: "notify" },
		missing: { method: "input" },
	});

	assert.deepEqual([...ids].sort(), ["agent-a", "agent-b"]);
});

test("question status replaces normal idle/running labels", () => {
	const { getSidebarAgentStatus } = loadModule();

	assert.equal(getSidebarAgentStatus("idle", true), "question");
	assert.equal(getSidebarAgentStatus("running", true), "question");
	assert.equal(getSidebarAgentStatus("starting", true), "starting");
	assert.equal(getSidebarAgentStatus("error", true), "error");
	assert.equal(getSidebarAgentStatus("closed", true), "closed");
	assert.equal(getSidebarAgentStatus("idle", false), "idle");
});
