/**
 * Git Commands Extension
 *
 * Registers three commands:
 *   /git-commit [message]       - Stage all changes and commit
 *   /git-push                   - Push commits to remote
 *   /git-commit-push [message]  - Stage, commit, and push in one go
 *
 * Place in .pi/extensions/ or ~/.pi/agent/extensions/ for auto-discovery.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // ── /git-commit ──────────────────────────────────────────────
  pi.registerCommand("git-commit", {
    description: "Stage all changes and create a commit",
    handler: async (args, ctx) => {
      // Determine commit message
      let message = args.trim();

      if (!message) {
        const input = await ctx.ui.input("Commit message", {
          placeholder: "直接回车让 AI 自动生成，或输入信息后提交...",
          required: false,
        });
        // Esc → cancel
        if (input === undefined) {
          ctx.ui.notify("Commit cancelled", "warning");
          return;
        }
        message = input.trim();
      }

      // No commit message provided → let AI write it
      if (!message) {
        ctx.ui.notify("🤖 正在让 AI 分析变更并生成 commit message...", "info");
        pi.sendUserMessage(
          `请帮我完成一次 git commit。

要求：
1. 先执行 \`git diff --cached\` 查看已暂存的变更，如果没有暂存内容则执行 \`git diff\` 查看工作区变更
2. 使用 \`git add -A\` 暂存所有变更
3. 根据变更内容，按照 Conventional Commits 规范生成标准的 commit message（如 \`feat:\`, \`fix:\`, \`refactor:\`, \`docs:\` 等）
4. 用 \`git commit -m "<message>"\` 提交

请直接执行，不要询问我确认。`,
        );
        return;
      }

      ctx.ui.setStatus("git", "🚧 Staging & committing...");

      try {
        // Stage all changes
        const addResult = await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
        if (addResult.code !== 0) {
          ctx.ui.notify(`git add failed:\n${addResult.stderr}`, "error");
          return;
        }

        // Check if there's anything to commit
        const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
        if (!statusResult.stdout.trim()) {
          ctx.ui.notify("No changes to commit", "warning");
          return;
        }

        // Commit
        const commitResult = await pi.exec("git", ["commit", "-m", message], { cwd: ctx.cwd });
        if (commitResult.code !== 0) {
          ctx.ui.notify(`git commit failed:\n${commitResult.stderr}`, "error");
          return;
        }

        ctx.ui.notify(`✅ Commit created: ${message}`, "success");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Git error: ${msg}`, "error");
      } finally {
        ctx.ui.setStatus("git", undefined);
      }
    },
  });

  // ── /git-push ────────────────────────────────────────────────
  pi.registerCommand("git-push", {
    description: "Push commits to remote",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("git", "📤 Pushing...");

      try {
        // Show which remote/branch we're pushing to
        const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: ctx.cwd,
        });
        const branch = branchResult.stdout.trim();

        const remoteResult = await pi.exec("git", ["remote", "get-url", "origin"], {
          cwd: ctx.cwd,
        });
        const remote = remoteResult.stdout.trim();

        const ok = await ctx.ui.confirm(
          "Push?",
          `Push branch \`${branch}\` to \n\`${remote}\`?`,
        );
        if (!ok) {
          ctx.ui.notify("Push cancelled", "warning");
          return;
        }

        const pushResult = await pi.exec("git", ["push"], { cwd: ctx.cwd });
        if (pushResult.code !== 0) {
          ctx.ui.notify(`git push failed:\n${pushResult.stderr}`, "error");
          return;
        }

        ctx.ui.notify(`✅ Pushed \`${branch}\` to remote`, "success");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Git error: ${msg}`, "error");
      } finally {
        ctx.ui.setStatus("git", undefined);
      }
    },
  });

  // ── /git-commit-push ────────────────────────────────────────
  pi.registerCommand("git-commit-push", {
    description: "Stage all changes, commit, and push in one go",
    handler: async (args, ctx) => {
      // Determine commit message
      let message = args.trim();

      if (!message) {
        const input = await ctx.ui.input("Commit message", {
          placeholder: "直接回车让 AI 自动生成，或输入信息后提交并推送...",
          required: false,
        });
        // Esc → cancel
        if (input === undefined) {
          ctx.ui.notify("Commit & push cancelled", "warning");
          return;
        }
        message = input.trim();
      }

      // No commit message provided → let AI write it and push
      if (!message) {
        ctx.ui.notify("🤖 正在让 AI 分析变更并生成 commit message...", "info");
        pi.sendUserMessage(
          `请帮我完成一次 git commit 并推送到远程。

要求：
1. 先执行 \`git diff --cached\` 查看已暂存的变更，如果没有暂存内容则执行 \`git diff\` 查看工作区变更
2. 使用 \`git add -A\` 暂存所有变更
3. 根据变更内容，按照 Conventional Commits 规范生成标准的 commit message（如 \`feat:\`, \`fix:\`, \`refactor:\`, \`docs:\` 等）
4. 用 \`git commit -m "<message>"\` 提交
5. 用 \`git push\` 推送到远程

请直接执行，不要询问我确认。`,
        );
        return;
      }

      ctx.ui.setStatus("git", "🚧 Staging & committing...");

      try {
        // Stage all changes
        const addResult = await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
        if (addResult.code !== 0) {
          ctx.ui.notify(`git add failed:\n${addResult.stderr}`, "error");
          return;
        }

        // Check if there's anything to commit
        const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
        if (!statusResult.stdout.trim()) {
          ctx.ui.notify("No changes to commit", "warning");
          return;
        }

        // Commit
        const commitResult = await pi.exec("git", ["commit", "-m", message], { cwd: ctx.cwd });
        if (commitResult.code !== 0) {
          ctx.ui.notify(`git commit failed:\n${commitResult.stderr}`, "error");
          return;
        }

        ctx.ui.notify(`✅ Commit created: ${message}`, "success");

        // Push
        ctx.ui.setStatus("git", "📤 Pushing...");
        const pushResult = await pi.exec("git", ["push"], { cwd: ctx.cwd });
        if (pushResult.code !== 0) {
          ctx.ui.notify(`Commit succeeded, but git push failed:\n${pushResult.stderr}`, "error");
          return;
        }

        // Get branch name for success message
        const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.cwd });
        const branch = branchResult.stdout.trim();
        ctx.ui.notify(`✅ Committed and pushed \`${branch}\` to remote`, "success");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Git error: ${msg}`, "error");
      } finally {
        ctx.ui.setStatus("git", undefined);
      }
    },
  });
}
