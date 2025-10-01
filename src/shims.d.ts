declare module '@modelcontextprotocol/sdk/server/stdio' {
  export class StdioServerTransport {
    constructor(...args: any[]);
  }
}

declare module '@modelcontextprotocol/sdk/server/mcp' {
  export class McpServer {
    constructor(info: { name: string; version: string }, options?: any);
    connect(transport: any): Promise<void>;
    tool(name: string, description: string, schema: any, cb: (args: any, extra?: any) => Promise<any>): any;
    resource(name: string, uri: string, readCallback: (uri: URL, extra?: any) => Promise<any>): any;
    registerResource(name: string, uri: string, config: any, readCallback: (uri: URL, extra?: any) => Promise<any>): any;
    server: any;
  }
}
