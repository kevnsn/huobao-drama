/**
 * MCP over stdio, for Claude Code and Codex CLI: `npm run -s mcp`.
 * stdout carries protocol messages only, so nothing here may print to it.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './server.js'

await createMcpServer().connect(new StdioServerTransport())
