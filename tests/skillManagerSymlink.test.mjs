import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nativeRequire = createRequire(import.meta.url);

function loadSkillManager() {
	const source = readFileSync("src/main/skills/SkillManager.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			moduleResolution: ts.ModuleResolutionKind.NodeJs,
		},
	});
	const sandbox = {
		exports: {},
		require: (specifier) => {
			if (specifier === "electron") return { shell: { openPath: async () => undefined } };
			if (specifier === "../../shared/types") return {};
			return nativeRequire(specifier);
		},
		process,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SkillManager.ts" });
	return sandbox.exports.SkillManager;
}

function skillMarkdown(name) {
	return `---\nname: ${name}\ndescription: test skill\n---\n`;
}

test("scans directory skills through symlinks and stops cyclic links", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-skills-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const shared = join(root, "shared", "linked-skill");
	await mkdir(join(shared, "nested"), { recursive: true });
	await writeFile(join(shared, "nested", "SKILL.md"), skillMarkdown("linked-skill"));

	const home = join(root, "home");
	const piSkills = join(home, ".pi", "agent", "skills");
	await mkdir(piSkills, { recursive: true });
	await symlink(shared, join(piSkills, "linked-skill"), "junction");
	await symlink(shared, join(shared, "cycle"), "junction");

	const SkillManager = loadSkillManager();
	const manager = new SkillManager(home);
	const result = await manager.list();
	const linked = result.skills.filter((skill) => skill.name === "linked-skill");

	assert.equal(linked.length, 1);
	assert.equal(linked[0].path, join(piSkills, "linked-skill", "nested", "SKILL.md"));
});
