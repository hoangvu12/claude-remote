import { HandlerPipeline } from "./pipeline.js";
import { ThinkingHandler } from "./handlers/thinking.js";
import { PlanModeHandler } from "./handlers/plan-mode.js";
import { TaskHandler } from "./handlers/tasks.js";
import { McpToolHandler } from "./handlers/mcp-tools.js";
import { PassiveToolHandler } from "./handlers/passive-tools.js";
import { ToolResultHandler } from "./handlers/tool-result.js";
import { EditWriteHandler } from "./handlers/edit-write.js";
import { ToolUseHandler } from "./handlers/tool-use.js";
import { DefaultHandler } from "./handlers/default.js";

/**
 * Create the message handler pipeline.
 * Order matters — mirrors the priority of the original _flushBatch if/else chain.
 */
export function createPipeline(): HandlerPipeline {
  const pipeline = new HandlerPipeline();
  pipeline.register(new ThinkingHandler());       // show/clear thinking indicator
  pipeline.register(new PlanModeHandler());       // EnterPlanMode/ExitPlanMode → status embed
  pipeline.register(new TaskHandler());           // Task* tools → pinned embed (before other tool handling)
  pipeline.register(new McpToolHandler());        // mcp__* tools → "Querying ServerName..." grouped
  pipeline.register(new PassiveToolHandler());    // Read/Grep/Glob → grouped inline embed or thread
  pipeline.register(new ToolResultHandler());     // tool-result routing (inline/thread)
  pipeline.register(new EditWriteHandler());      // Edit/Write → inline display
  pipeline.register(new ToolUseHandler());        // other tool-use → inline embed, escalate if slow/long
  pipeline.register(new DefaultHandler());        // everything else → renderMessage
  return pipeline;
}
