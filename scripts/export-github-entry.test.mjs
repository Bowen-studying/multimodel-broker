import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FILE_MAPPINGS, exportEntry } from "./export-github-entry.mjs";

test("export is deterministic and check mode detects drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-learning-export-"));
  const sourceRoot = path.join(root, "source");
  const destinationRoot = path.join(root, "destination");
  try {
    for (const mapping of FILE_MAPPINGS) {
      const sourcePath = path.join(sourceRoot, mapping.source);
      await mkdir(path.dirname(sourcePath), { recursive: true });
      const content = mapping.stripFrontmatter
        ? "---\nname: ai-learning-assistant\n---\n\n# Test teaching source\n"
        : "# Test reference\n";
      await writeFile(sourcePath, content, "utf8");
    }
    const written = await exportEntry({ sourceRoot, destinationRoot });
    assert.equal(written.status, "exported");
    const checked = await exportEntry({ sourceRoot, destinationRoot, check: true });
    assert.equal(checked.status, "consistent");
    const manifestPath = path.join(destinationRoot, "00_学习系统/AI_LEARNING_ASSISTANT/export-manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");
    await writeFile(
      path.join(destinationRoot, "00_学习系统/AI_LEARNING_ASSISTANT/TEACHING.md"),
      "drift\n",
      "utf8",
    );
    await assert.rejects(
      exportEntry({ sourceRoot, destinationRoot, check: true }),
      (error) => error?.mismatches?.some((item) => item.path.endsWith("/TEACHING.md")),
    );
    await exportEntry({ sourceRoot, destinationRoot });
    const manifestAfter = await readFile(manifestPath, "utf8");
    assert.equal(manifestAfter, manifestBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

