import { listChannelPlugins } from "../channels/plugins/index.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  assertCommandRegistry,
  buildBuiltinChatCommands,
  defineChatCommand,
} from "./commands-registry.shared.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";

type ChannelPlugin = ReturnType<typeof listChannelPlugins>[number];

function defineDockCommand(plugin: ChannelPlugin): ChatCommandDefinition {
  return defineChatCommand({
    key: `dock:${plugin.id}`,
    nativeName: `dock_${plugin.id}`,
    description: `Switch to ${plugin.id} for replies.`,
    textAliases: [`/dock-${plugin.id}`, `/dock_${plugin.id}`],
    category: "docks",
  });
}

let cachedCommands: ChatCommandDefinition[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let cachedNativeCommandSurfaces: Set<string> | null = null;
let cachedNativeRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

function buildChatCommands(): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [
    ...buildBuiltinChatCommands(),
    defineChatCommand({
      key: "mybalances",
      nativeName: "mybalances",
      description: "Show exchange account balances. Refreshes in place.",
      textAlias: "/mybalances",
      acceptsArgs: false,
      category: "tools",
    }),
    defineChatCommand({
      key: "mypositions",
      nativeName: "mypositions",
      description: "Show open positions across exchanges. Refreshes in place.",
      textAlias: "/mypositions",
      acceptsArgs: false,
      category: "tools",
    }),
    defineChatCommand({
      key: "myorders",
      nativeName: "myorders",
      description: "Show open orders across exchanges. Refreshes in place.",
      textAlias: "/myorders",
      acceptsArgs: false,
      category: "tools",
    }),
    defineChatCommand({
      key: "mypredictionpositions",
      nativeName: "mypredictionpositions",
      description: "Show prediction market positions (Polymarket). Refreshes in place.",
      textAlias: "/mypredictionpositions",
      acceptsArgs: false,
      category: "tools",
    }),
    defineChatCommand({
      key: "mypredictionorders",
      nativeName: "mypredictionorders",
      description: "Show prediction market open orders (Polymarket). Refreshes in place.",
      textAlias: "/mypredictionorders",
      acceptsArgs: false,
      category: "tools",
    }),
    defineChatCommand({
      key: "mystrategies",
      nativeName: "mystrategies",
      description:
        "List your strategies with status. Tap a strategy for controls: start, stop, restart, logs.",
      textAlias: "/mystrategies",
      acceptsArgs: true,
      category: "tools",
    }),
    defineChatCommand({
      key: "update_portara",
      nativeName: "update_portara",
      description: "Update your trading tools and agent to the latest version.",
      textAlias: "/update_portara",
      acceptsArgs: false,
      category: "tools",
    }),
    ...listChannelPlugins()
      .filter((plugin) => plugin.capabilities.nativeCommands)
      .map((plugin) => defineDockCommand(plugin)),
  ];

  assertCommandRegistry(commands);
  return commands;
}

export function getChatCommands(): ChatCommandDefinition[] {
  const registry = getActivePluginRegistry();
  if (cachedCommands && registry === cachedRegistry) {
    return cachedCommands;
  }
  const commands = buildChatCommands();
  cachedCommands = commands;
  cachedRegistry = registry;
  cachedNativeCommandSurfaces = null;
  return commands;
}

export function getNativeCommandSurfaces(): Set<string> {
  const registry = getActivePluginRegistry();
  if (cachedNativeCommandSurfaces && registry === cachedNativeRegistry) {
    return cachedNativeCommandSurfaces;
  }
  cachedNativeCommandSurfaces = new Set(
    listChannelPlugins()
      .filter((plugin) => plugin.capabilities.nativeCommands)
      .map((plugin) => plugin.id),
  );
  cachedNativeRegistry = registry;
  return cachedNativeCommandSurfaces;
}
