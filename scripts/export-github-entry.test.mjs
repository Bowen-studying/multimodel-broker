import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FILE_MAPPINGS, exportEntry } from "./export-github-entry.mjs";

test("export is deterministic and check mode detects missing files and drift", async () => {
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
    const assessmentPath = "00_学习系统/AI_LEARNING_ASSISTANT/assessment.md";
    const questionDesignPath = "00_学习系统/AI_LEARNING_ASSISTANT/question-design.md";
    for (const referencePath of [assessmentPath, questionDesignPath]) {
      assert.ok(written.files.includes(referencePath));
      assert.ok((await readFile(path.join(destinationRoot, referencePath), "utf8")).endsWith("# Test reference\n"));
    }
    const checked = await exportEntry({ sourceRoot, destinationRoot, check: true });
    assert.equal(checked.status, "consistent");
    const manifestPath = path.join(destinationRoot, "00_学习系统/AI_LEARNING_ASSISTANT/export-manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestBefore);
    assert.equal(manifest.files.length, 6);
    const questionDesignEntries = manifest.files.filter((item) => item.path === questionDesignPath);
    assert.equal(questionDesignEntries.length, 1);
    assert.equal(questionDesignEntries[0].source, "plugins/ai-learning-assistant/skills/ai-learning-assistant/references/question-design.md");
    for (const driftPath of ["00_学习系统/AI_LEARNING_ASSISTANT/TEACHING.md", assessmentPath, questionDesignPath]) {
      await writeFile(path.join(destinationRoot, driftPath), "drift\n", "utf8");
      await assert.rejects(
        exportEntry({ sourceRoot, destinationRoot, check: true }),
        (error) => error?.mismatches?.some((item) => item.path === driftPath && item.reason === "content"),
      );
      await exportEntry({ sourceRoot, destinationRoot });
    }
    await rm(path.join(destinationRoot, questionDesignPath));
    await assert.rejects(
      exportEntry({ sourceRoot, destinationRoot, check: true }),
      (error) => error?.mismatches?.some((item) => item.path === questionDesignPath && item.reason === "missing"),
    );
    await exportEntry({ sourceRoot, destinationRoot });
    const manifestAfter = await readFile(manifestPath, "utf8");
    assert.equal(manifestAfter, manifestBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SKILL reference links relocate known files and preserve fragments and other content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-learning-links-"));
  const sourceRoot = path.join(root, "source");
  const destinationRoot = path.join(root, "destination");
  const body = [
    "# Teaching",
    "[出题](references/question-design.md)",
    "[自动调度](references/question-design.md#按阶段与题目用途自动调度)",
    "[任务设计](./references/question-design.md#出题前的任务设计)",
    "[验题](references/question-design.md#发题前验题 \"发题前验题\")",
    "[巩固](references/question-design.md#巩固与复习)",
    "[评判](references/assessment.md#逐项判定)",
    "[记录](./references/record-format.md \"记录格式\")",
    "[上下文](references/context-and-plan.md)",
    "[约定](references/tool-contract.md#保存与核验)",
    "[未知](references/other.md#保持)",
    "[外部](https://example.com/references/assessment.md#保持)",
    "[同目录](assessment.md#保持)",
    "正文保留 references/assessment.md，不改写普通路径。",
    "",
  ].join("\n");
  const expectedBody = [
    "# Teaching",
    "[出题](question-design.md)",
    "[自动调度](question-design.md#按阶段与题目用途自动调度)",
    "[任务设计](question-design.md#出题前的任务设计)",
    "[验题](question-design.md#发题前验题 \"发题前验题\")",
    "[巩固](question-design.md#巩固与复习)",
    "[评判](assessment.md#逐项判定)",
    "[记录](record-format.md \"记录格式\")",
    "[上下文](context-and-plan.md)",
    "[约定](tool-contract.md#保存与核验)",
    "[未知](references/other.md#保持)",
    "[外部](https://example.com/references/assessment.md#保持)",
    "[同目录](assessment.md#保持)",
    "正文保留 references/assessment.md，不改写普通路径。",
    "",
  ].join("\n");
  try {
    for (const mapping of FILE_MAPPINGS) {
      const sourcePath = path.join(sourceRoot, mapping.source);
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, mapping.stripFrontmatter
        ? "---\nname: ai-learning-assistant\n---\n\n" + body
        : "# Reference\n[原文](references/assessment.md#保持)\n", "utf8");
    }
    await exportEntry({ sourceRoot, destinationRoot });
    const teaching = await readFile(path.join(destinationRoot, "00_学习系统/AI_LEARNING_ASSISTANT/TEACHING.md"), "utf8");
    assert.equal(teaching, "<!-- Generated from Bowen-studying/multimodel-broker:plugins/ai-learning-assistant/skills/ai-learning-assistant/SKILL.md; edit that source and re-export. -->\n\n" + expectedBody);
    const assessment = await readFile(path.join(destinationRoot, "00_学习系统/AI_LEARNING_ASSISTANT/assessment.md"), "utf8");
    assert.ok(assessment.endsWith("# Reference\n[原文](references/assessment.md#保持)\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

