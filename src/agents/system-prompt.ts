import { createHmac, createHash } from "node:crypto";
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { buildMemoryPromptSection } from "../plugins/memory-state.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { EmbeddedSandboxInfo } from "./pi-embedded-runner/types.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";
type OwnerIdDisplay = "raw" | "hash";

function buildSkillsSection(params: { skillsPrompt?: string; readToolName: string }) {
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) {
    return [];
  }
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    "- When a skill drives external API writes, assume rate limits: prefer fewer larger writes, avoid tight one-item loops, serialize bursts when possible, and respect 429/Retry-After.",
    trimmed,
    "",
  ];
}

function buildMemorySection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) {
  if (params.isMinimal) {
    return [];
  }
  return buildMemoryPromptSection({
    availableTools: params.availableTools,
    citationsMode: params.citationsMode,
  });
}

function buildUserIdentitySection(ownerLine: string | undefined, isMinimal: boolean) {
  if (!ownerLine || isMinimal) {
    return [];
  }
  return ["## Authorized Senders", ownerLine, ""];
}

function formatOwnerDisplayId(ownerId: string, ownerDisplaySecret?: string) {
  const hasSecret = ownerDisplaySecret?.trim();
  const digest = hasSecret
    ? createHmac("sha256", hasSecret).update(ownerId).digest("hex")
    : createHash("sha256").update(ownerId).digest("hex");
  return digest.slice(0, 12);
}

function buildOwnerIdentityLine(
  ownerNumbers: string[],
  ownerDisplay: OwnerIdDisplay,
  ownerDisplaySecret?: string,
) {
  const normalized = ownerNumbers.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return undefined;
  }
  const displayOwnerNumbers =
    ownerDisplay === "hash"
      ? normalized.map((ownerId) => formatOwnerDisplayId(ownerId, ownerDisplaySecret))
      : normalized;
  return `Authorized senders: ${displayOwnerNumbers.join(", ")}. These senders are allowlisted; do not assume they are the owner.`;
}

function buildTimeSection(params: { userTimezone?: string }) {
  if (!params.userTimezone) {
    return [];
  }
  return ["## Current Date & Time", `Time zone: ${params.userTimezone}`, ""];
}

function buildReplyTagsSection(isMinimal: boolean) {
  if (isMinimal) {
    return [];
  }
  return [
    "## Quoting",
    "Prefix with [[reply_to_current]] to quote the trigger, or [[reply_to:<id>]] for a specific message.",
    "Must be the first token. Removed before delivery. Not all channels support this.",
    "",
  ];
}

function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  messageChannelOptions: string;
  inlineButtonsEnabled: boolean;
  runtimeChannel?: string;
  messageToolHints?: string[];
}) {
  if (params.isMinimal) {
    return [];
  }
  return [
    "## Messaging",
    "- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)",
    "- Cross-session messaging → use send_sessions(sessionKey, message)",
    "- Sub-agent orchestration → use sub_agents(action=list|steer|kill)",
    `- Runtime-generated completion events may ask for a user update. Rewrite those in your normal assistant voice and send the update (do not forward raw internal metadata or default to ${SILENT_REPLY_TOKEN}).`,
    "- Never use shell_exec/curl for provider messaging; the system handles all routing internally.",
    params.availableTools.has("send_message")
      ? [
          "",
          "### send_message tool",
          "- Use `send_message` for proactive sends + channel actions (polls, reactions, etc.).",
          "- For `action=send`, include `to` and `message`.",
          `- If multiple channels are configured, pass \`channel\` (${params.messageChannelOptions}).`,
          `- If you use \`send_message\` (\`action=send\`) to deliver your user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN} (avoid duplicate replies).`,
          params.inlineButtonsEnabled
            ? "- Inline buttons supported. Use `action=send` with `buttons=[[{text,callback_data,style?}]]`; `style` can be `primary`, `success`, or `danger`."
            : params.runtimeChannel
              ? `- Inline buttons not enabled for ${params.runtimeChannel}. If you need them, ask to set ${params.runtimeChannel}.capabilities.inlineButtons ("dm"|"group"|"all"|"allowlist").`
              : "",
          ...(params.messageToolHints ?? []),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}

function buildVoiceSection(params: { isMinimal: boolean; ttsHint?: string }) {
  if (params.isMinimal) {
    return [];
  }
  const hint = params.ttsHint?.trim();
  if (!hint) {
    return [];
  }
  return ["## Voice (TTS)", hint, ""];
}

function buildDocsSection(params: { docsPath?: string; isMinimal: boolean; readToolName: string }) {
  const docsPath = params.docsPath?.trim();
  if (!docsPath || params.isMinimal) {
    return [];
  }
  return [
    "## Documentation",
    `Docs: ${docsPath}`,
    "For behavior, commands, config, or architecture questions: consult local docs first.",
    "",
  ];
}

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  ownerDisplay?: OwnerIdDisplay;
  ownerDisplaySecret?: string;
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  skillsPrompt?: string;
  heartbeatPrompt?: string;
  docsPath?: string;
  workspaceNotes?: string[];
  ttsHint?: string;
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  /** Whether ACP-specific routing guidance should be included. Defaults to true. */
  acpEnabled?: boolean;
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    channel?: string;
    capabilities?: string[];
    repoRoot?: string;
  };
  messageToolHints?: string[];
  sandboxInfo?: EmbeddedSandboxInfo;
  /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  memoryCitationsMode?: MemoryCitationsMode;
}) {
  const acpEnabled = params.acpEnabled !== false;
  const sandboxedRuntime = params.sandboxInfo?.enabled === true;
  const acpSpawnRuntimeEnabled = acpEnabled && !sandboxedRuntime;
  const coreToolSummaries: Record<string, string> = {
    read: "Retrieve the contents of a file",
    write: "Create a new file or replace an existing one",
    edit: "Apply targeted modifications to a file",
    apply_patch: "Patch one or more files at once",
    grep: "Look for patterns inside file contents",
    find: "Locate files matching a glob expression",
    ls: "Show the entries in a directory",
    shell_exec: "Execute shell commands (pty mode supported for interactive CLIs)",
    process_ctrl: "Manage background shell execution sessions",
    web_search: "Query the web for information",
    web_fetch: "Download and extract readable content from a given URL",
    // Channel docking: add login tools here when a channel needs interactive linking.
    web_browser: "Operate the built-in page viewer",
    canvas: "Display, evaluate, or capture a snapshot of the Canvas",
    nodes: "Enumerate, describe, notify, capture camera or screen on linked nodes",
    cron: "Manage scheduled jobs and wake events (use for reminders; when scheduling a reminder, phrase the systemEvent so it reads naturally as a reminder at fire time, mentioning it is a reminder based on the delay; include relevant recent context in the reminder body if appropriate)",
    send_message: "Deliver messages and perform channel actions",
    gateway: "Restart, apply configuration, or trigger updates on the running assistant process",
    list_agents: acpSpawnRuntimeEnabled
      ? 'Enumerate agent identifiers available for spawn_sessions when runtime="subagent" (excludes ACP harness ids)'
      : "Enumerate agent identifiers available for spawn_sessions",
    list_sessions: "Show other sessions (including sub-agents) with filtering and recency options",
    history_sessions: "Retrieve conversation history for a different session or sub-agent",
    send_sessions: "Dispatch a message to another session or sub-agent",
    spawn_sessions: acpSpawnRuntimeEnabled
      ? 'Launch an isolated sub-agent or ACP coding session (runtime="acp" needs `agentId` unless `acp.defaultAgent` is set; ACP harness ids use acp.allowedAgents, not list_agents)'
      : "Launch an isolated sub-agent session",
    sub_agents: "Enumerate, redirect, or terminate sub-agent runs for this requester session",
    status_session:
      "Display a status card equivalent to /status (usage, elapsed time, Reasoning/Verbose/Elevated); helpful for model-use inquiries (📊 status_session); supports per-session model override",
    image: "Interpret an image using the configured image model",
    image_generate: "Produce images via the configured image-generation model",
  };

  const toolOrder = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "grep",
    "find",
    "ls",
    "shell_exec",
    "process_ctrl",
    "code_execution",
    "web_search",
    "web_fetch",
    "web_browser",
    "canvas",
    "nodes",
    "cron",
    "send_message",
    "gateway",
    "list_agents",
    "list_sessions",
    "history_sessions",
    "send_sessions",
    "sub_agents",
    "status_session",
    "image",
    "image_generate",
  ];

  const rawToolNames = (params.toolNames ?? []).map((tool) => tool.trim());
  const canonicalToolNames = rawToolNames.filter(Boolean);
  // Preserve caller casing while deduping tool names by lowercase.
  const canonicalByNormalized = new Map<string, string>();
  for (const name of canonicalToolNames) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = canonicalToolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  const hasSessionsSpawn = availableTools.has("spawn_sessions");
  const acpHarnessSpawnAllowed = hasSessionsSpawn && acpSpawnRuntimeEnabled;
  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(params.toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !value?.trim()) {
      continue;
    }
    externalToolSummaries.set(normalized, value.trim());
  }
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !toolOrder.includes(tool))),
  );
  const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });
  for (const tool of extraTools.toSorted()) {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    toolLines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
  }

  const readToolName = resolveToolName("read");
  const execToolName = resolveToolName("shell_exec");
  const processToolName = resolveToolName("process_ctrl");
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerDisplay = params.ownerDisplay === "hash" ? "hash" : "raw";
  const ownerLine = buildOwnerIdentityLine(
    params.ownerNumbers ?? [],
    ownerDisplay,
    params.ownerDisplaySecret,
  );
  const reasoningHint = params.reasoningTagHint
    ? [
        "ALL internal reasoning MUST be inside <think>...</think>.",
        "Do not output any analysis outside <think>.",
        "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
        "Only the final user-visible reply may appear inside <final>.",
        "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
        "Example:",
        "<think>Short internal reasoning.</think>",
        "<final>Hey there! What would you like to do next?</final>",
      ].join(" ")
    : undefined;
  const reasoningLevel = params.reasoningLevel ?? "off";
  const userTimezone = params.userTimezone?.trim();
  const skillsPrompt = params.skillsPrompt?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const runtimeInfo = params.runtimeInfo;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");
  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";
  const sandboxContainerWorkspace = params.sandboxInfo?.containerWorkspaceDir?.trim();
  const sanitizedWorkspaceDir = sanitizeForPromptLiteral(params.workspaceDir);
  const sanitizedSandboxContainerWorkspace = sandboxContainerWorkspace
    ? sanitizeForPromptLiteral(sandboxContainerWorkspace)
    : "";
  const displayWorkspaceDir =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? sanitizedSandboxContainerWorkspace
      : sanitizedWorkspaceDir;
  const workspaceGuidance =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? `For read/write/edit/apply_patch, file paths resolve against host workspace: ${sanitizedWorkspaceDir}. For bash/exec commands, use sandbox container paths under ${sanitizedSandboxContainerWorkspace} (or relative paths from that workdir), not host paths. Prefer relative paths so both sandboxed exec and file tools work consistently.`
      : "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.";
  const safetySection = [
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    "",
  ];
  const skillsSection = buildSkillsSection({
    skillsPrompt,
    readToolName,
  });
  const memorySection = buildMemorySection({
    isMinimal,
    availableTools,
    citationsMode: params.memoryCitationsMode,
  });
  const docsSection = buildDocsSection({
    docsPath: params.docsPath,
    isMinimal,
    readToolName,
  });
  const workspaceNotes = (params.workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean);

  // For "none" mode, return just the basic identity line
  if (promptMode === "none") {
    return "You are a personal assistant.";
  }

  const lines = [
    "You are a personal assistant.",
    "",
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    toolLines.length > 0
      ? toolLines.join("\n")
      : [
          "The standard tools listed above are available. This runtime also provides:",
          "- grep: look for patterns inside file contents",
          "- find: locate files matching a glob expression",
          "- ls: show directory entries",
          "- apply_patch: patch one or more files at once",
          `- ${execToolName}: execute shell commands (supports background via yieldMs/background)`,
          `- ${processToolName}: manage background shell execution sessions`,
          "- web_browser: operate the built-in page viewer",
          "- canvas: display, evaluate, or capture a snapshot of the Canvas",
          "- nodes: enumerate, describe, notify, capture camera or screen on linked nodes",
          "- cron: manage scheduled jobs and wake events (use for reminders; phrase the systemEvent so it reads naturally as a reminder at fire time, mention it is a reminder based on the delay; include relevant recent context in the reminder body if appropriate)",
          "- list_sessions: show sessions",
          "- history_sessions: retrieve session history",
          "- send_sessions: dispatch a message to another session",
          "- sub_agents: enumerate, redirect, or terminate sub-agent runs",
          '- status_session: display usage, elapsed time, and model state; answers "what model are we using?"',
        ].join("\n"),
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    `For long waits, avoid rapid poll loops: use ${execToolName} with enough yieldMs or ${processToolName}(action=poll, timeout=<ms>).`,
    "If a task is more complex or takes longer, spawn a sub-agent. Completion is push-based: it will auto-announce when done.",
    ...(acpHarnessSpawnAllowed
      ? [
          'For requests like "do this in codex/claude code/cursor/gemini" or similar ACP harnesses, treat it as ACP harness intent and call `spawn_sessions` with `runtime: "acp"`.',
          'On Discord, default ACP harness requests to thread-bound persistent sessions (`thread: true`, `mode: "session"`) unless the user asks otherwise.',
          "Set `agentId` explicitly unless `acp.defaultAgent` is configured, and do not route ACP harness requests through `sub_agents`/`list_agents` or local PTY exec flows.",
          'For ACP harness thread spawns, do not call `send_message` with `action=thread-create`; use `spawn_sessions` (`runtime: "acp"`, `thread: true`) as the single thread creation path.',
        ]
      : []),
    "Do not poll `sub_agents list` / `list_sessions` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).",
    "",
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI or slash commands.",
    "When shell_exec returns approval-pending, include the concrete /approve command from tool output (with allow-once|allow-always|deny) and do not ask for a different or rotated code.",
    "Treat allow-once as single-command only: if another elevated command needs approval, request a fresh /approve and do not claim prior approval covered it.",
    "When approvals are required, preserve and show the full command/script exactly as provided (including chained operators like &&, ||, |, ;, or multiline shells) so the user can approve what will actually run.",
    "",
    ...safetySection,
    ...skillsSection,
    ...memorySection,
    "",
    // Skip model aliases for subagent/none modes
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "## Model Aliases"
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "Prefer aliases when specifying model overrides; full provider/model is also accepted."
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? params.modelAliasLines.join("\n")
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal ? "" : "",
    userTimezone
      ? "If you need the current date, time, or day of week, run status_session (📊 status_session)."
      : "",
    "## Workspace",
    `Your working directory is: ${displayWorkspaceDir}`,
    workspaceGuidance,
    ...workspaceNotes,
    "",
    ...docsSection,
    params.sandboxInfo?.enabled ? "## Sandbox" : "",
    params.sandboxInfo?.enabled
      ? [
          "You are running in a sandboxed runtime (tools execute in Docker).",
          "Some tools may be unavailable due to sandbox policy.",
          "Sub-agents stay sandboxed (no elevated/host access). Need outside-sandbox read/write? Don't spawn; ask first.",
          hasSessionsSpawn && acpEnabled
            ? 'ACP harness spawns are blocked from sandboxed sessions (`spawn_sessions` with `runtime: "acp"`). Use `runtime: "subagent"` instead.'
            : "",
          params.sandboxInfo.containerWorkspaceDir
            ? `Sandbox container workdir: ${sanitizeForPromptLiteral(params.sandboxInfo.containerWorkspaceDir)}`
            : "",
          params.sandboxInfo.workspaceDir
            ? `Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): ${sanitizeForPromptLiteral(params.sandboxInfo.workspaceDir)}`
            : "",
          params.sandboxInfo.workspaceAccess
            ? `Agent workspace access: ${params.sandboxInfo.workspaceAccess}${
                params.sandboxInfo.agentWorkspaceMount
                  ? ` (mounted at ${sanitizeForPromptLiteral(params.sandboxInfo.agentWorkspaceMount)})`
                  : ""
              }`
            : "",
          params.sandboxInfo.browserBridgeUrl ? "Sandbox browser: enabled." : "",
          params.sandboxInfo.browserNoVncUrl
            ? `Sandbox browser observer (noVNC): ${sanitizeForPromptLiteral(params.sandboxInfo.browserNoVncUrl)}`
            : "",
          params.sandboxInfo.hostBrowserAllowed === true
            ? "Host browser control: allowed."
            : params.sandboxInfo.hostBrowserAllowed === false
              ? "Host browser control: blocked."
              : "",
          params.sandboxInfo.elevated?.allowed
            ? "Elevated exec is available for this session."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "User can toggle with /elevated on|off|ask|full."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "You may also send /elevated on|off|ask|full when needed."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? `Current elevated level: ${params.sandboxInfo.elevated.defaultLevel} (ask runs exec on host with approvals; full auto-approves).`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    params.sandboxInfo?.enabled ? "" : "",
    ...buildUserIdentitySection(ownerLine, isMinimal),
    ...buildTimeSection({
      userTimezone,
    }),
    "## Workspace Files (injected)",
    "These user-editable files are loaded by the runtime and included below in Project Context.",
    "",
    ...buildReplyTagsSection(isMinimal),
    ...buildMessagingSection({
      isMinimal,
      availableTools,
      messageChannelOptions,
      inlineButtonsEnabled,
      runtimeChannel,
      messageToolHints: params.messageToolHints,
    }),
    ...buildVoiceSection({ isMinimal, ttsHint: params.ttsHint }),
  ];

  if (extraSystemPrompt) {
    // Use "Subagent Context" header for minimal mode (subagents), otherwise "Group Chat Context"
    const contextHeader =
      promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
    lines.push(contextHeader, extraSystemPrompt, "");
  }
  if (params.reactionGuidance) {
    const { level, channel } = params.reactionGuidance;
    const guidanceText =
      level === "minimal"
        ? [
            `Reactions are enabled for ${channel} in MINIMAL mode.`,
            "React ONLY when truly relevant:",
            "- Acknowledge important user requests or confirmations",
            "- Express genuine sentiment (humor, appreciation) sparingly",
            "- Avoid reacting to routine messages or your own replies",
            "Guideline: at most 1 reaction per 5-10 exchanges.",
          ].join("\n")
        : [
            `Reactions are enabled for ${channel} in EXTENSIVE mode.`,
            "Feel free to react liberally:",
            "- Acknowledge messages with appropriate emojis",
            "- Express sentiment and personality through reactions",
            "- React to interesting content, humor, or notable events",
            "- Use reactions to confirm understanding or agreement",
            "Guideline: react whenever it feels natural.",
          ].join("\n");
    lines.push("## Reactions", guidanceText, "");
  }
  if (reasoningHint) {
    lines.push("## Reasoning Format", reasoningHint, "");
  }

  const contextFiles = params.contextFiles ?? [];
  const validContextFiles = contextFiles.filter(
    (file) => typeof file.path === "string" && file.path.trim().length > 0,
  );
  if (validContextFiles.length > 0) {
    lines.push("# Project Context", "");
    if (validContextFiles.length > 0) {
      const hasSoulFile = validContextFiles.some((file) => {
        const normalizedPath = file.path.trim().replace(/\\/g, "/");
        const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
        return baseName.toLowerCase() === "soul.md";
      });
      lines.push("The following project context files have been loaded:");
      if (hasSoulFile) {
        lines.push(
          "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
        );
      }
      lines.push("");
    }
    for (const file of validContextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // Skip silent replies for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## Silent Replies",
      `When you have nothing to say, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
      "",
      "⚠️ Rules:",
      "- It must be your ENTIRE message — nothing else",
      `- Never append it to an actual response (never include "${SILENT_REPLY_TOKEN}" in real replies)`,
      "- Never wrap it in markdown or code blocks",
      "",
      `❌ Wrong: "Here's help... ${SILENT_REPLY_TOKEN}"`,
      `❌ Wrong: "${SILENT_REPLY_TOKEN}"`,
      `✅ Right: ${SILENT_REPLY_TOKEN}`,
      "",
    );
  }

  // Skip heartbeats for subagent/none modes
  if (!isMinimal && heartbeatPrompt) {
    lines.push(
      "## Heartbeats",
      `Heartbeat prompt: ${heartbeatPrompt}`,
      "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:",
      "HEARTBEAT_OK",
      'A leading/trailing "HEARTBEAT_OK" in your reply is treated as an acknowledgement and may be silently discarded.',
      'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
      "",
    );
  }

  lines.push(
    "## Runtime",
    buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel),
    `Reasoning: ${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.`,
  );

  return lines.filter(Boolean).join("\n");
}

export function buildRuntimeLine(
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    repoRoot?: string;
  },
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
  defaultThinkLevel?: ThinkLevel,
): string {
  return `Runtime: ${[
    runtimeInfo?.agentId ? `agent=${runtimeInfo.agentId}` : "",
    runtimeInfo?.host ? `host=${runtimeInfo.host}` : "",
    runtimeInfo?.repoRoot ? `repo=${runtimeInfo.repoRoot}` : "",
    runtimeInfo?.os
      ? `os=${runtimeInfo.os}${runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : ""}`
      : runtimeInfo?.arch
        ? `arch=${runtimeInfo.arch}`
        : "",
    runtimeInfo?.node ? `node=${runtimeInfo.node}` : "",
    runtimeInfo?.model ? `model=${runtimeInfo.model}` : "",
    runtimeInfo?.defaultModel ? `default_model=${runtimeInfo.defaultModel}` : "",
    runtimeInfo?.shell ? `shell=${runtimeInfo.shell}` : "",
    runtimeChannel ? `channel=${runtimeChannel}` : "",
    runtimeChannel
      ? `capabilities=${runtimeCapabilities.length > 0 ? runtimeCapabilities.join(",") : "none"}`
      : "",
    `thinking=${defaultThinkLevel ?? "off"}`,
  ]
    .filter(Boolean)
    .join(" | ")}`;
}
