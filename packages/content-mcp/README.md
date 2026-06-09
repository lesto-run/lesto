# @usedocks/mcp

MCP (Model Context Protocol) server for Docks content engine.

## Installation

```bash
npm install @usedocks/mcp
```

## Quick Start

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "docks": {
      "command": "npx",
      "args": ["docks", "mcp"]
    }
  }
}
```

## Features

- **Content access** - Read and search your content
- **Schema awareness** - AI understands your content structure
- **Collection tools** - List, filter, and query collections
- **Voice context** - Include voice profiles in prompts

## Available Tools

| Tool | Description |
|------|-------------|
| `list_collections` | List all content collections |
| `get_entry` | Get a specific entry by ID |
| `search_content` | Search across collections |
| `get_schema` | Get collection schema info |

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
