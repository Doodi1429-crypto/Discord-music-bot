export class AITool {
  constructor(name, execute) {
    this.name = name;
    this.execute = execute;
  }
}

export class ToolRegistry {
  constructor() { this.tools = new Map(); }
  registerTool(tool) { this.tools.set(tool.name, tool); return this; }
  async execute(name, input) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown AI tool: ${name}`);
    return tool.execute(input);
  }
}
