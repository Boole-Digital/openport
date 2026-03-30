import { handleAcpCommand } from "./commands-acp.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleApproveCommand } from "./commands-approve.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleBtwCommand } from "./commands-btw.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import {
  handleCommandsListCommand,
  handleContextCommand,
  handleExportSessionCommand,
  handleHelpCommand,
  handleStatusCommand,
  handleToolsCommand,
  handleWhoamiCommand,
} from "./commands-info.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { handleModelsCommand } from "./commands-models.js";
import { handlePluginCommand } from "./commands-plugin.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import {
  handleAbortTrigger,
  handleActivationCommand,
  handleFastCommand,
  handleRestartCommand,
  handleSendPolicyCommand,
  handleSessionCommand,
  handleStopCommand,
  handleUsageCommand,
} from "./commands-session.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleTtsCommands } from "./commands-tts.js";
import type { CommandHandler } from "./commands-types.js";
import { handleExchangeCommand } from "./commands-exchange.js";
import { handleMyStrategiesCommand } from "./commands-strategies.js";
import { handleMyOrdersCommand } from "./commands-orders.js";
import { handleUpdatePortaraCommand } from "./commands-update-portara.js";

export function loadCommandHandlers(): CommandHandler[] {
  return [
    handlePluginCommand,
    handleBtwCommand,
    handleBashCommand,
    handleActivationCommand,
    handleSendPolicyCommand,
    handleFastCommand,
    handleUsageCommand,
    handleSessionCommand,
    handleRestartCommand,
    handleTtsCommands,
    handleHelpCommand,
    handleCommandsListCommand,
    handleToolsCommand,
    handleStatusCommand,
    handleAllowlistCommand,
    handleApproveCommand,
    handleContextCommand,
    handleExportSessionCommand,
    handleWhoamiCommand,
    handleSubagentsCommand,
    handleAcpCommand,
    handleMcpCommand,
    handlePluginsCommand,
    handleConfigCommand,
    handleDebugCommand,
    handleModelsCommand,
    handleExchangeCommand,
    handleMyStrategiesCommand,
    handleMyOrdersCommand,
    handleUpdatePortaraCommand,
    handleStopCommand,
    handleCompactCommand,
    handleAbortTrigger,
  ];
}
