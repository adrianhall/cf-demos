import { describe, expect, it, vi } from "vitest";
import {
  deleteSkillDirectory,
  putSkillMarkdown,
  skillDirectoryKey,
  skillMarkdownKey,
} from "./storage";

describe("skillDirectoryKey", () => {
  it("builds a shared enterprise-scoped directory for a null owner", () => {
    expect(skillDirectoryKey(null, "skill-1")).toBe(
      "skills/enterprise/skill-1",
    );
  });

  it("builds a per-owner personal-scoped directory otherwise", () => {
    expect(skillDirectoryKey("alice@example.com", "skill-1")).toBe(
      "skills/personal/alice@example.com/skill-1",
    );
  });
});

describe("skillMarkdownKey", () => {
  it("appends /SKILL.md to the directory key", () => {
    expect(skillMarkdownKey("skills/enterprise/skill-1")).toBe(
      "skills/enterprise/skill-1/SKILL.md",
    );
  });
});

describe("putSkillMarkdown", () => {
  it("writes the markdown content to R2 under the directory's SKILL.md key", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const bucket = { put } as unknown as R2Bucket;

    await putSkillMarkdown(
      bucket,
      "skills/enterprise/skill-1",
      "---\n---\nbody",
    );

    expect(put).toHaveBeenCalledWith(
      "skills/enterprise/skill-1/SKILL.md",
      "---\n---\nbody",
      { httpMetadata: { contentType: "text/markdown; charset=utf-8" } },
    );
  });
});

describe("deleteSkillDirectory", () => {
  it("deletes every object listed under the directory's own prefix", async () => {
    const list = vi.fn().mockResolvedValue({
      objects: [
        { key: "skills/enterprise/skill-1/SKILL.md" },
        { key: "skills/enterprise/skill-1/references/notes.md" },
      ],
      truncated: false,
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const bucket = { list, delete: del } as unknown as R2Bucket;

    await deleteSkillDirectory(bucket, "skills/enterprise/skill-1");

    expect(list).toHaveBeenCalledWith({
      prefix: "skills/enterprise/skill-1/",
      cursor: undefined,
    });
    expect(del).toHaveBeenCalledWith([
      "skills/enterprise/skill-1/SKILL.md",
      "skills/enterprise/skill-1/references/notes.md",
    ]);
  });

  it("pages through a truncated listing before deleting anything", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [{ key: "skills/enterprise/skill-1/SKILL.md" }],
        truncated: true,
        cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        objects: [{ key: "skills/enterprise/skill-1/references/notes.md" }],
        truncated: false,
      });
    const del = vi.fn().mockResolvedValue(undefined);
    const bucket = { list, delete: del } as unknown as R2Bucket;

    await deleteSkillDirectory(bucket, "skills/enterprise/skill-1");

    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "skills/enterprise/skill-1/",
      cursor: "cursor-1",
    });
    expect(del).toHaveBeenCalledWith([
      "skills/enterprise/skill-1/SKILL.md",
      "skills/enterprise/skill-1/references/notes.md",
    ]);
  });

  it("never calls delete when the directory has no objects", async () => {
    const list = vi.fn().mockResolvedValue({ objects: [], truncated: false });
    const del = vi.fn();
    const bucket = { list, delete: del } as unknown as R2Bucket;

    await deleteSkillDirectory(bucket, "skills/enterprise/skill-1");

    expect(del).not.toHaveBeenCalled();
  });
});
