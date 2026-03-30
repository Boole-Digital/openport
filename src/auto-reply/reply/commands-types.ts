import type { BlockReplyChunking } from "../../agents/pi-embedded-block-chunker.js";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import type { MsgContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.js";
import type { TypingController } from "./typing.js";

export type CommandContext = {
  surface: string;
  channel: string;
  channelId?: ChannelId;
  ownerList: string[];
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  senderId?: string;
  abortKey?: string;
  rawBodyNormalized: string;
  commandBodyNormalized: string;
  from?: string;
  to?: string;
  /** Internal marker to prevent duplicate reset-hook emission across command pipelines. */
  resetHookTriggered?: boolean;
};

export type HandleCommandsParams = {
  ctx: MsgContext;
  rootCtx?: MsgContext;
  cfg: OpenClawConfig;
  command: CommandContext;
  agentId?: string;
  agentDir?: string;
  directives: InlineDirectives;
  elevated: {
    enabled: boolean;
    allowed: boolean;
    failures: Array<{ gate: string; key: string }>;
  };
  sessionEntry?: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope?: SessionScope;
  workspaceDir: string;
  opts?: GetReplyOptions;
  defaultGroupActivation: () => "always" | "mention";
  resolvedThinkLevel?: ThinkLevel;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  provider: string;
  model: string;
  contextTokens: number;
  isGroup: boolean;
  skillCommands?: SkillCommandSpec[];
  typing?: TypingController;
};

export type CommandHandlerResult = {
  reply?: ReplyPayload;
  shouldContinue: boolean;
  /**
   * When set and shouldContinue is true, the agent sees this body instead of
   * the original message. Used for hidden context injection (e.g. "Work on
   * Strategy" — injects the strategy filepath into the agent's turn without
   * showing the raw callback_data in the chat).
   */
  agentMessageOverride?: string;
};

export type CommandHandler = (
  params: HandleCommandsParams,
  allowTextCommands: boolean,
) => Promise<CommandHandlerResult | null>;
