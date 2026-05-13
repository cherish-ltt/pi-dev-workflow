/**
 * Git Commands Extension
 *
 * Registers two commands:
 *   /git-commit [message]  - Stage all changes and commit
 *   /git-push              - Push commits to remote
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
          placeholder: "Enter commit message...",
          required: true,
        });
        if (input === undefined) {
          ctx.ui.notify("Commit cancelled", "warning");
          return;
        }
        message = input;
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
}
