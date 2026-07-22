import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync("resources/extensions/pi-deck-nul-redirect-fix.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		process: { platform: "win32" },
		require: (specifier) => {
			if (specifier === "@earendil-works/pi-coding-agent") {
				return { isToolCallEventType: () => false };
			}
			throw new Error(`Unexpected require: ${specifier}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "pi-deck-nul-redirect-fix.ts" });
	return sandbox.exports;
}

const { normalizeNulRedirects } = loadModule();

test("rewrites Windows NUL redirects without touching quoted text or filenames", () => {
	assert.equal(
		normalizeNulRedirects("git status > nul && npm test 2>> NUL", "win32"),
		"git status >/dev/null && npm test 2>>/dev/null",
	);
	assert.equal(normalizeNulRedirects('echo "> nul" > nul.txt', "win32"), 'echo "> nul" > nul.txt');
	assert.equal(normalizeNulRedirects("echo \"> nul\" \\> nul", "win32"), 'echo "> nul" \\> nul');
});

test("does not rewrite NUL on non-Windows platforms", () => {
	assert.equal(normalizeNulRedirects("command > nul", "linux"), "command > nul");
});
