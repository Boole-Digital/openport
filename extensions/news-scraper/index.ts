import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { registerNewsCli } from "./src/cli.js";
import { registerNewsCommands } from "./src/commands.js";
import { createNewsTool } from "./src/news-tool.js";

export default function register(api: OpenClawPluginApi) {
  // Agent tool: check_news — available in conversations and cron agent turns
  api.registerTool(createNewsTool(api) as unknown as AnyAgentTool);

  // CLI: openclaw news add|list|remove|check|status
  api.registerCli(({ program }) => registerNewsCli(program, api), { commands: ["news"] });

  // Telegram/channel commands: /news and /newswatch
  registerNewsCommands(api);
}
