import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-remotes-build-"));
const repositoryDir = mkdtempSync(join(tmpdir(), "pideck-git-remotes-"));
const emptyRepositoryDir = mkdtempSync(join(tmpdir(), "pideck-git-remotes-empty-"));
let GitService;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

before(() => {
  // 与 gitCommitFileDiff.integration.test.mjs 同模式：真实实现 + 真实 git 仓库
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "src/main/git/GitService.ts",
      "src/shared/types.ts",
      "--module",
      "commonjs",
      "--target",
      "es2022",
      "--moduleResolution",
      "node",
      "--esModuleInterop",
      "--skipLibCheck",
      "--outDir",
      buildDir,
    ],
    { cwd: resolve("."), stdio: "pipe" },
  );
  const stubElectronDir = join(buildDir, "node_modules", "electron");
  mkdirSync(stubElectronDir, { recursive: true });
  writeFileSync(join(stubElectronDir, "package.json"), JSON.stringify({ name: "electron", main: "index.js" }));
  writeFileSync(join(stubElectronDir, "index.js"), "exports.shell = {};");
  ({ GitService } = require(join(buildDir, "main/git/GitService.js")));

  git(repositoryDir, "init");
  git(repositoryDir, "config", "core.autocrlf", "false");
  git(emptyRepositoryDir, "init");
});

after(() => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(repositoryDir, { recursive: true, force: true });
  rmSync(emptyRepositoryDir, { recursive: true, force: true });
});

test("getBranches returns remotes with fetch URL preferred over push URL", async () => {
  git(repositoryDir, "remote", "add", "origin", "https://example.com/fetch-default.git");
  // 显式 push URL 与 fetch 不同：必须按名称去重且保留 fetch URL
  git(repositoryDir, "remote", "set-url", "--push", "origin", "https://push.example.com/repo.git");
  const service = new GitService();
  const info = await service.getBranches(repositoryDir);
  assert.deepEqual(info.remotes, [{ name: "origin", url: "https://example.com/fetch-default.git" }]);
});

test("getBranches lists multiple remotes and returns empty for repositories without remotes", async () => {
  git(repositoryDir, "remote", "add", "upstream", "git@github.com:example/upstream.git");
  const service = new GitService();
  const info = await service.getBranches(repositoryDir);
  assert.deepEqual(info.remotes, [
    { name: "origin", url: "https://example.com/fetch-default.git" },
    { name: "upstream", url: "git@github.com:example/upstream.git" },
  ]);

  const emptyService = new GitService();
  const emptyInfo = await emptyService.getBranches(emptyRepositoryDir);
  assert.deepEqual(emptyInfo.remotes, []);
});
