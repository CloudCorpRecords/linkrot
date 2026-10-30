/**
 * linkrot MCP server. Tool: check_links.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheck, VERSION } from "./core.js";

const server = new McpServer({ name: "linkrot", version: VERSION });

server.tool(
  "check_links",
  "Check links in a repo's markdown: relative links and anchors resolved against the filesystem (missing file is a finding), external links reported as UNCHECKED in offline mode or classified dead, moved, bot-blocked, or healthy when online checks run. Verdict OK when no dead or missing links are found, FINDINGS otherwise.",
  {
    path: z.string().describe("Target path to check"),
  },
  async ({ path }) => {
    const report = runCheck(path);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
