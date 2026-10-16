---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Strongly prefer `dev_ask` for every round when it is available. Call it directly, not through codemode or another tool. Send the whole current frontier in one call: each question has a short `header`, a complete `question`, and 2-4 mutually exclusive options with `label` and `description`. Put your recommendation first and append `（推荐）` to its label. Do not add custom-answer or back options yourself; the tool supplies them. Use an optional Markdown `preview` only when comparing concrete layouts, diagrams, code, or configurations; put ASCII diagrams and code in fenced blocks to preserve alignment.

Wait for the tool's answers before recomputing the frontier and making the next call. Reuse settled answers instead of asking them again. Cancelled or unanswered questions remain open decisions, not acceptance of your recommendation.

If `dev_ask` is unavailable or the session has no interactive UI, use this text format for a round:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

In the text fallback, word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), investigate it yourself with read-only tools before asking the user. Do not dispatch sub-agents; this package does not provide them. An unresolved fact is an unsettled prerequisite: hold the questions that depend on it, and ask only the rest of the settled frontier. Don't ask the user for anything you could look up yourself. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
