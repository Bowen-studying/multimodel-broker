#!/usr/bin/env node
/**
 * Validate the plugin wrapper before it is committed.
 *
 * The wrapper is only metadata, so nothing here builds or runs the broker. The
 * checks follow the structure OpenAI publishes in `openai/plugins`
 * (`.agents/plugins/marketplace.json`, `plugins/<name>/.codex-plugin/plugin.json`,
 * `.app.json`) and the rules the official `plugin-creator` skill documents.
 *
 * The last check matters most for this repository: the plugin must never carry the
 * MCP endpoint URL, its token, or any provider key. Binding happens through
 * `.app.json`, which holds an opaque connector id only.
 *
 *   node scripts/check-plugin.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
const INSTALL_POLICIES = new Set(["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"]);
const AUTH_POLICIES = new Set(["ON_INSTALL", "ON_USE"]);
const CAPABILITIES = new Set(["Interactive", "Read", "Write"]);

const failures = [];
const checks = [];
const check = (label, ok, detail) => {
  checks.push(label);
  if (!ok) failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
};
/** A warning never fails the build: the connector id is account-scoped and may be filled later. */
const warn = (message) => console.log(`[WARN] ${message}`);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// 1. Marketplace
if (!existsSync(marketplacePath)) {
  check("marketplace exists at .agents/plugins/marketplace.json", false);
} else {
  const marketplace = readJson(marketplacePath);
  check("marketplace declares a name", typeof marketplace.name === "string" && marketplace.name.length > 0, marketplace.name);
  check("marketplace interface.displayName is set", typeof marketplace.interface?.displayName === "string" && !marketplace.interface.displayName.includes("TODO"));
  check("marketplace lists at least one plugin", Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0);

  for (const entry of marketplace.plugins ?? []) {
    const label = `marketplace entry "${entry.name}"`;
    check(`${label} has a local source path`, entry.source?.source === "local" && typeof entry.source.path === "string", entry.source?.path);
    check(
      `${label} uses allowed policy values`,
      INSTALL_POLICIES.has(entry.policy?.installation) && AUTH_POLICIES.has(entry.policy?.authentication),
      `${entry.policy?.installation}/${entry.policy?.authentication}`,
    );
    check(`${label} declares a category`, typeof entry.category === "string" && entry.category.length > 0, entry.category);

    const pluginDir = path.resolve(repoRoot, entry.source?.path ?? "");
    check(`${label} path exists`, existsSync(pluginDir), entry.source?.path);
    if (!existsSync(pluginDir)) continue;

    // 2. Plugin manifest (the file the official scaffolder always creates)
    const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
    check(`${label} has .codex-plugin/plugin.json`, existsSync(manifestPath));
    if (!existsSync(manifestPath)) continue;

    const manifest = readJson(manifestPath);
    check(`${label} manifest name matches the entry`, manifest.name === entry.name, manifest.name);
    check(`${label} manifest carries no TODO placeholders`, !JSON.stringify(manifest).includes("TODO"));
    check(`${label} manifest declares a version and description`, Boolean(manifest.version) && Boolean(manifest.description));

    const capabilities = manifest.interface?.capabilities ?? [];
    check(
      `${label} capabilities are from the allowed set`,
      capabilities.every((capability) => CAPABILITIES.has(capability)),
      capabilities.join(",") || "(none)",
    );
    // This broker's tools are all readOnlyHint: true - claiming Write would be dishonest.
    check(`${label} does not claim Write`, !capabilities.includes("Write"));

    // 3. App binding
    if (manifest.apps) {
      const appPath = path.resolve(pluginDir, manifest.apps);
      check(`${label} apps file exists`, existsSync(appPath), manifest.apps);
      if (existsSync(appPath)) {
        const apps = readJson(appPath);
        const entries = Object.entries(apps.apps ?? {});
        check(`${label} binds at least one app`, entries.length > 0);
        for (const [alias, value] of entries) {
          check(`${label} app "${alias}" has an id`, typeof value?.id === "string" && value.id.length > 0, value.id);
          if (/REPLACE|TODO|CHANGEME/i.test(String(value?.id ?? ""))) {
            warn(`${label} app "${alias}" still holds a placeholder id - fill it with the connector id from ChatGPT dev mode before installing the plugin in Codex`);
          }
        }
      }
    }

    // 4. No secrets anywhere in the wrapper
    const files = [];
    const walk = (dir) => {
      for (const item of readdirSync(dir)) {
        const full = path.join(dir, item);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(pluginDir);
    const offenders = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/trycloudflare\.com|ngrok|tunnel\?token|token=|\bsk-[A-Za-z0-9]{10,}|\b[0-9a-f]{48}\b/.test(text)) offenders.push(path.relative(repoRoot, file));
    }
    check(`${label} carries no endpoint URL, token or key`, offenders.length === 0, offenders.join(","));
  }
}

console.log(`\n${checks.length - failures.length} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
