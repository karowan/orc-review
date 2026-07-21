import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigError } from "../src/config.js";
import { listRegistry, loadLocalReviewers } from "../src/registry.js";

function tmpRegistry(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-review-registry-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const KAROWAN_MD = `---
model: claude-fable-5
can_block: true
---
You are Kyle's bot. Audit for evidence-backed defects only.
`;

describe("local registry", () => {
  it("lists simple and composite bots", () => {
    const dir = tmpRegistry({
      "karowan.md": KAROWAN_MD,
      "team-sec/reviewer.yaml": "lanes:\n  - prompt: p.md\n",
      "team-sec/p.md": "prompt",
      "README.txt": "not a bot",
    });
    expect(listRegistry(dir)).toEqual(["karowan", "team-sec"]);
  });

  it("loads a bot forced advisory with (local) labeling", () => {
    const dir = tmpRegistry({ "karowan.md": KAROWAN_MD });
    const [bot] = loadLocalReviewers(["karowan"], dir);
    expect(bot.id).toBe("karowan");
    expect(bot.displayName).toBe("Karowan (local)");
    expect(bot.canBlock).toBe(false); // frontmatter said true — authority never comes from the registry
    expect(bot.required).toBe(false);
    expect(bot.lanes[0].model).toBe("claude-fable-5");
  });

  it("errors on unknown names", () => {
    const dir = tmpRegistry({});
    expect(() => loadLocalReviewers(["ghost"], dir)).toThrow(ConfigError);
    try {
      loadLocalReviewers(["ghost"], dir);
    } catch (err) {
      expect((err as ConfigError).problems.join()).toContain('registry bot "ghost" not found');
    }
  });

  it("surfaces compile problems from bot files", () => {
    const dir = tmpRegistry({ "bad.md": "---\nmystery: 1\n---\nprompt" });
    expect(() => loadLocalReviewers(["bad"], dir)).toThrow(ConfigError);
  });

  it("errors on invalid names before touching the filesystem", () => {
    expect(() => loadLocalReviewers(["../escape"], "/nonexistent")).toThrow(ConfigError);
  });
});
