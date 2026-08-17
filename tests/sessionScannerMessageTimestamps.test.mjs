import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadSessionScanner(homePath) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => homePath }, shell: {} };
			if (id === "../../shared/codexSessionMeta") return { getCodexSessionThreadInfo: () => undefined };
			if (id === "../../shared/sessionPath") {
				return { normalizeSessionPath: (value) => String(value).replace(/\\/g, "/").toLowerCase() };
			}
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	return sandbox.exports.SessionScanner;
}

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

test("SessionScanner parses ISO and numeric message timestamps for daily summaries", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-summary-timestamps-"));
	try {
		const sessionPath = join(home, ".pi", "agent", "sessions", "session.jsonl");
		const isoTimestamp = "2026-08-17T15:21:50.856Z";
		const numericTimestamp = Date.parse("2026-08-17T15:22:50.856Z");
		writeSession(sessionPath, [
			{ type: "message", timestamp: isoTimestamp, message: { role: "user", content: "ISO message" } },
			{ type: "message", ts: numericTimestamp, message: { role: "assistant", content: "numeric message" } },
			{ type: "message", timestamp: "not-a-timestamp", message: { role: "user", content: "invalid message" } },
		]);

		const SessionScanner = loadSessionScanner(home);
		const messages = await new SessionScanner().readMessages(sessionPath);

		assert.deepEqual(Array.from(messages, (message) => message.timestamp), [
			Date.parse(isoTimestamp),
			numericTimestamp,
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
