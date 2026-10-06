import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Star charts were generating recurring image-only commits; keep both the producer and README consumer removed.
test("repository workflows do not schedule or expose Star History updates", () => {
  const directory = ".github/workflows";
  const producers = readdirSync(directory)
    .filter(name => /\.ya?ml$/i.test(name))
    .filter(name => /star[-\s]?history/i.test(readFileSync(join(directory, name), "utf8")));
  assert.deepEqual(producers, [], "Star History workflows must not be reintroduced");
});

for (const path of ["README.md", "README.en.md"]) {
  test(`${path} does not embed or reference Star History charts`, () => {
    const content = readFileSync(path, "utf8");
    assert.doesNotMatch(content, /star[-\s]?history/i);
  });
}
