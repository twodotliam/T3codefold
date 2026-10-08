import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3AgentBrowserInstructionsFor,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./T3OrchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "T3 Code interaction mode: Default");
    assert.include(injected, "T3 Code collaborative browser");
    assert.include(injected, "T3 Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "T3 Code interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "T3 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "T3 Code collaborative browser");
    assert.notInclude(withoutMcp, "T3 Code orchestration");
  });
  describe("agent-browser tooling", () => {
    const cdpUrl = "ws://127.0.0.1:3773/api/preview/cdp?thread=t&token=secret";
    const session = { browserTooling: "agent-browser" as const, previewCdpUrl: cdpUrl };

    it("gives no block unless the session prefers agent-browser and has an endpoint", () => {
      assert.isUndefined(
        t3AgentBrowserInstructionsFor(
          { browserTooling: "t3", previewCdpUrl: cdpUrl },
          {
            includeUrl: true,
          },
        ),
      );
      assert.isUndefined(
        t3AgentBrowserInstructionsFor({ browserTooling: "agent-browser" }, { includeUrl: true }),
      );
      assert.isUndefined(t3AgentBrowserInstructionsFor(undefined, { includeUrl: true }));
    });

    it("names the URL only for providers without AGENT_BROWSER_CDP", () => {
      const withEnv = t3AgentBrowserInstructionsFor(session, { includeUrl: false })!;
      assert.include(withEnv, "already pointed at this thread's tabs through `AGENT_BROWSER_CDP`");
      assert.notInclude(withEnv, "token=");
      const withUrl = t3AgentBrowserInstructionsFor(session, { includeUrl: true })!;
      assert.include(withUrl, cdpUrl);
    });

    it("replaces the preview-first block for ACP agents and resends when it changes", () => {
      const agentBrowser = t3AgentBrowserInstructionsFor(session, { includeUrl: true });
      const state = { interactionMode: "default" as const, hasT3Mcp: true };
      const prompt = t3AcpPromptWithInstructions({
        prompt: "Check the page.",
        state: { ...state, agentBrowserInstructions: agentBrowser },
        previousState: state,
      });
      assert.include(prompt, "T3 Code browser: agent-browser");
      assert.notInclude(prompt, T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim());
    });

    it("adds the block after the orchestration instructions for system prompts", () => {
      const agentBrowser = t3AgentBrowserInstructionsFor(session, { includeUrl: false });
      const systemPrompt = t3OrchestrationSystemPrompt(true, agentBrowser)!;
      assert.include(systemPrompt, T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
      assert.include(systemPrompt, "T3 Code browser: agent-browser");
      assert.strictEqual(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    });
  });
});
