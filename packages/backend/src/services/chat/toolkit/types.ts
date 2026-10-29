import type { ChatPageContext, ChatRunEvent, ChatSource, ChatToolCallPart } from '@bt/shared/types';
import type Users from '@models/users.model';

import type { ToolCatalogEntry, ToolInvokeExtra } from '../../mcp/tool-catalog';
import type { PickedRecord } from '../prompt/picked-records';
import type { ChatTextPolicy } from '../prompt/text-policy';
import type { AnalysisOutput } from '../sandbox/run-sandboxed-analysis';
import type { ChatRunLimits } from './limits';

/** A JSON Schema object, as the providers and the bridge's `tools/list` receive it. */
export type JsonSchema = Record<string, unknown>;

/** `read` runs a catalog read, `write` proposes a card, `native` is a tool the chat itself defines. */
export type ChatToolKind = 'read' | 'write' | 'native';

/**
 * What a tool returns to the model. A failure the model can act on (a bad argument, a handler
 * error, a limit) is a result with `isError`, never a thrown run error: the run goes on.
 */
export interface ChatToolResult {
  isError: boolean;
  text: string;
  /** What the stored tool-call record keeps when the text is wrapped or long; defaults to the start of `text`. */
  summary?: string;
}

export type ChatToolValidation = { success: true; value: unknown } | { success: false; error: Error };

/** One tool as a runner offers it, whatever the transport (AI SDK, MCP bridge). */
export interface ChatToolDefinition {
  name: string;
  description: string;
  /** The JSON Schema the provider (or the bridge's `tools/list`) sees. */
  modelSchema: JsonSchema;
  kind: ChatToolKind;
  /**
   * Checks an input and answers it unchanged: the input keeps its `$proposal:` refs and `_chat`.
   * `execute` is the one place that strips and substitutes.
   */
  validate: (params: { input: unknown }) => ChatToolValidation;
  execute: (params: { input: unknown; callId?: string }) => Promise<ChatToolResult>;
}

/** What the toolkit needs from the run that owns it. */
export interface ChatToolkitRun {
  /** The user the run belongs to; the read-only auth info is built from it. */
  user: Pick<Users, 'id' | 'username' | 'authUserId' | 'role'>;
  threadId: string;
  /** The assistant message the run fills; every card it proposes belongs to it. */
  messageId: string;
  runId: string;
  pageContext: ChatPageContext | null;
  /**
   * The turn is likely to change data (the message has an attachment, or the thread already has
   * cards), so the common write tools are offered from the first step instead of being found first.
   */
  preloadWrites?: boolean;
  /** The records the user picked in their answer to the model's last question (the message this run answers). */
  pickedRecords?: PickedRecord[];
  /** The attachments of the user message this run answers. */
  attachments: Array<{ id: string; fileName: string }>;
  /** Writes one event to the run's stream. */
  emit: (event: ChatRunEvent) => void | Promise<void>;
  textPolicy: ChatTextPolicy;
  /** Called once, when the model asks the user a question and the run must stop. */
  onAwaitingClarification?: () => void;
  /**
   * Opens a `toolCall` part before each tool call and closes it with the outcome. The AI SDK runner
   * leaves it off because it writes those parts from its own stream; the CLI bridge has no such stream.
   */
  announceToolCalls?: boolean;
  /** Wraps untrusted text (a tool result, an attachment) before the model sees it; identity when absent. */
  wrapUntrusted?: (params: { kind: 'toolResult' | 'attachment'; text: string }) => string;
}

/** A read the run made: kept whole for the run, while the model sees a capped copy. */
export interface ChatReadRecord {
  callId: string;
  toolName: string;
  args: unknown;
  fullText: string;
}

/** The mutable state one toolkit keeps for its run. */
export interface ChatToolkitState {
  awaitingClarification: boolean;
  discovered: Set<string>;
  reads: Map<string, ChatReadRecord>;
  sources: ChatSource[];
  limits: ChatRunLimits;
  visuals: number;
  /** The output of every analysis of the run that succeeded, by analysis id, for `render_*` to show. */
  analyses: Map<string, AnalysisOutput>;
  /** Notices already shown, so a cap is announced once. */
  noticed: Set<string>;
  records: Array<Omit<ChatToolCallPart, 'type' | 'id'>>;
}

/** What every tool module receives. */
export interface ChatToolContext {
  run: ChatToolkitRun;
  state: ChatToolkitState;
  catalog: readonly ToolCatalogEntry[];
  /** The read-only auth info, built on first use. */
  getExtra: () => Promise<ToolInvokeExtra>;
  /** Shows a server-made line (a cap, a notice) once per key. */
  notice: (params: { key: string; params?: Record<string, string | number> }) => Promise<void>;
}

export interface ChatToolkit {
  tools: readonly ChatToolDefinition[];
  getTool: (params: { name: string }) => ChatToolDefinition | undefined;
  /** The catalog tools fixed for the whole run: the core, and the preloaded writes when the run asked for them. */
  baseToolNames: () => string[];
  /** What a step offers: the base tools, the chat-native tools and what the model discovered. */
  activeToolNames: () => string[];
  isAwaitingClarification: () => boolean;
  /** The full result of an earlier read of this run, for analyses. */
  getReadResult: (params: { callId: string }) => string | null;
  toolCallRecords: () => ReadonlyArray<Omit<ChatToolCallPart, 'type' | 'id'>>;
}
