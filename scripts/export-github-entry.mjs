#!/usr/bin/env node
/**
 * Export the AI learning assistant teaching source into the GitHub learning entry.
 *
 * The source repository owns the teaching rules. The learning-system repository
 * owns course metadata, plans, sessions, evidence and formal capability state.
 *
 * Usage:
 *   node scripts/export-github-entry.mjs --destination-root <checkout>
 *   node scripts/export-github-entry.mjs --destination-root <checkout> --check
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const FILE_MAPPINGS = Object.freeze([
  {
    source: "plugins/ai-learning-assistant/skills/ai-learning-assistant/SKILL.md",
    destination: "00_学习系统/AI_LEARNING_ASSISTANT/TEACHING.md",
    stripFrontmatter: true,
  },
  {
    source: "plugins/ai-learning-assistant/skills/ai-learning-assistant/references/context-and-plan.md",
    destination: "00_学习系统/AI_LEARNING_ASSISTANT/context-and-plan.md",
    stripFrontmatter: false,
  },
  {
    source: "plugins/ai-learning-assistant/skills/ai-learning-assistant/references/record-format.md",
    destination: "00_学习系统/AI_LEARNING_ASSISTANT/record-format.md",
    stripFrontmatter: false,
  },
  {
    source: "plugins/ai-learning-assistant/skills/ai-learning-assistant/references/tool-contract.md",
    destination: "00_学习系统/AI_LEARNING_ASSISTANT/tool-contract.md",
    stripFrontmatter: false,
  },
]);

const GENERATED_HEADER = (source) =>
  "<!-- Generated from Bowen-studying/multimodel-broker:" + source + "; edit that source and re-export. -->\n\n";

function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function ensureFinalNewline(text) {
  return text.endsWith("\n") ? text : text + "\n";
}

function stripFrontmatter(text, source) {
  if (!source.endsWith("/SKILL.md")) return text;
  const match = text.match(/^---\n[\s\S]*?\n---\n\n/);
  if (!match) throw new Error("SKILL.md is missing the expected YAML frontmatter: " + source);
  return text.slice(match[0].length);
}

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function resolveInside(root, relativePath) {
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, relativePath);
  if (target !== rootPath && !target.startsWith(rootPath + path.sep)) {
    throw new Error("Path escapes configured root: " + relativePath);
  }
  return target;
}

function parseArgs(argv) {
  const options = { check: false, sourceRoot: path.resolve(import.meta.dirname, ".."), destinationRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--source-root" || arg === "--destination-root") {
      const value = argv[++index];
      if (!value) throw new Error("Missing value for " + arg);
      if (arg === "--source-root") options.sourceRoot = path.resolve(value);
      else options.destinationRoot = path.resolve(value);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }
  if (!options.destinationRoot) throw new Error("--destination-root is required; no learning-system checkout was selected.");
  return options;
}

export async function buildExport({ sourceRoot, destinationRoot }) {
  const outputs = [];
  for (const mapping of FILE_MAPPINGS) {
    const sourcePath = resolveInside(sourceRoot, mapping.source);
    const raw = normalize(await readFile(sourcePath, "utf8"));
    const sourceText = ensureFinalNewline(raw);
    const body = mapping.stripFrontmatter ? stripFrontmatter(sourceText, mapping.source) : sourceText;
    const generated = ensureFinalNewline(GENERATED_HEADER(mapping.source) + body);
    outputs.push({
      ...mapping,
      sourceSha256: sha256(sourceText),
      exportedSha256: sha256(generated),
      content: generated,
    });
  }
  const manifest = {
    schema: "ai-learning-github-entry-export/v2",
    sourceRepository: "Bowen-studying/multimodel-broker",
    destinationRepository: "Bowen-studying/ai-learning-system",
    files: outputs.map(({ source, destination, sourceSha256, exportedSha256 }) => ({
      source,
      path: destination,
      sourceSha256,
      exportedSha256,
    })),
    checks: {
      markdownOnly: true,
      sameDirectoryReferences: true,
      noRuntimeOrLearningData: true,
      canonicalCourseId: true,
    },
  };
  const manifestContent = JSON.stringify(manifest, null, 2) + "\n";
  return { outputs, manifestContent };
}

export async function exportEntry({ sourceRoot, destinationRoot, check = false }) {
  const { outputs, manifestContent } = await buildExport({ sourceRoot, destinationRoot });
  const expected = [...outputs.map((item) => ({ path: item.destination, content: item.content })), {
    path: "00_学习系统/AI_LEARNING_ASSISTANT/export-manifest.json",
    content: manifestContent,
  }];
  const mismatches = [];
  for (const item of expected) {
    const target = resolveInside(destinationRoot, item.path);
    if (check) {
      let actual;
      try {
        actual = await readFile(target, "utf8");
      } catch {
        mismatches.push({ path: item.path, reason: "missing" });
        continue;
      }
      if (normalize(actual) !== normalize(item.content)) mismatches.push({ path: item.path, reason: "content" });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, item.content, "utf8");
    }
  }
  if (check && mismatches.length) {
    const error = new Error("Generated learning entry is out of date.");
    error.mismatches = mismatches;
    throw error;
  }
  return { status: check ? "consistent" : "exported", files: expected.map((item) => item.path) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await exportEntry({
      sourceRoot: options.sourceRoot,
      destinationRoot: options.destinationRoot,
      check: options.check,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write("export-github-entry: " + error.message + "\n");
    if (error.mismatches) process.stderr.write(JSON.stringify(error.mismatches) + "\n");
    process.exitCode = 1;
  }
}
