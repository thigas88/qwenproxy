import crypto from 'crypto';
import { robustParseJSON } from '../utils/json.js';
import type { FunctionToolDefinition } from '../tools/types.js';
import type { Message } from '../utils/types.js';

export function getToolFunction(tool: FunctionToolDefinition | any): any {
  return tool?.type === 'function' ? tool.function : tool;
}

export function getToolName(tool: FunctionToolDefinition | any): string {
  return getToolFunction(tool)?.name || '';
}

export function getToolDescription(tool: FunctionToolDefinition | any): string {
  return getToolFunction(tool)?.description || '';
}

export function getToolParameters(tool: FunctionToolDefinition | any): Record<string, any> {
  return getToolFunction(tool)?.parameters?.properties || {};
}

export function getRequiredParams(tool: FunctionToolDefinition | any): Set<string> {
  return new Set(getToolFunction(tool)?.parameters?.required || []);
}

export function compactPromptText(text: string, maxChars = 180): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

export function getForcedToolName(toolChoice: any): string {
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    return toolChoice.function.name;
  }
  return '';
}

export function getToolChoiceMode(toolChoice: any): 'auto' | 'none' | 'required' | 'forced' {
  if (toolChoice === 'none') return 'none';
  if (toolChoice === 'required') return 'required';
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) return 'forced';
  return 'auto';
}

export function tokenizeForToolScoring(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9_./-]+/g) || []) {
    if (token.length >= 3) tokens.add(token);
  }
  return tokens;
}

export function scoreToolForContext(tool: FunctionToolDefinition, contextText: string, forcedToolName: string, recentToolNames: Set<string>): number {
  const name = getToolName(tool);
  const description = getToolDescription(tool);
  const params = Object.keys(getToolParameters(tool));
  const tokens = tokenizeForToolScoring(contextText);
  let score = 0;

  if (forcedToolName && name === forcedToolName) score += 100;
  if (recentToolNames.has(name)) score += 35;

  const nameParts = name.toLowerCase().split(/[_./-]+/).filter(Boolean);
  for (const part of nameParts) {
    if (part.length >= 3 && tokens.has(part)) score += 20;
  }

  const toolText = `${name} ${description} ${params.join(' ')}`.toLowerCase();
  for (const token of tokens) {
    if (toolText.includes(token)) score += 2;
  }

  for (const param of params) {
    if (tokens.has(param.toLowerCase())) score += 3;
  }

  return score;
}

export function getRecentToolNames(messages: Message[]): Set<string> {
  const recentToolNames = new Set<string>();
  const recentMessages = messages.slice(-12);

  for (const msg of recentMessages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (call?.function?.name) recentToolNames.add(call.function.name);
      }
    }
    if ((msg.role === 'tool' || msg.role === 'function') && msg.name) {
      recentToolNames.add(msg.name);
    }
  }

  return recentToolNames;
}

export function selectCandidateTools(
  tools: FunctionToolDefinition[],
  contextText: string,
  forcedToolName = '',
  recentToolNames: Set<string> = new Set(),
  maxTools = 12
): FunctionToolDefinition[] {
  if (tools.length <= maxTools) return tools;

  const scored = tools
    .map(tool => ({ tool, score: scoreToolForContext(tool, contextText, forcedToolName, recentToolNames) }))
    .filter(entry => entry.score > 0 || (forcedToolName && getToolName(entry.tool) === forcedToolName))
    .sort((a, b) => b.score - a.score || getToolName(a.tool).localeCompare(getToolName(b.tool)));

  if (scored.length === 0) {
    return tools.slice(0, maxTools);
  }

  return scored.slice(0, maxTools).map(entry => entry.tool);
}

export function buildCompactToolManifest(tools: FunctionToolDefinition[], forcedToolName = ''): string {
  if (tools.length === 0) return '';

  const lines = tools.map(tool => {
    const name = getToolName(tool);
    const description = compactPromptText(getToolDescription(tool), 140);
    const params = getToolParameters(tool);
    const required = getRequiredParams(tool);
    const signature = Object.entries(params)
      .map(([paramName, schema]: [string, any]) => {
        const optional = required.has(paramName) ? '' : '?';
        const type = schema?.type || 'any';
        return `${paramName}${optional}: ${type}`;
      })
      .join(', ');

    const marker = forcedToolName && name === forcedToolName ? ' [required]' : '';
    return `${name}(${signature})${description ? ` - ${description}` : ''}${marker}`;
  });

  return `[COMPACT TOOL MANIFEST]\n${lines.join('\n')}`;
}

export function buildToolCallContract(
  tools: FunctionToolDefinition[],
  forcedToolName = '',
  parallelToolCalls = true
): string {
  const names = tools.map(getToolName).filter(Boolean);
  const toolList = names.length > 0 ? names.join(', ') : 'none';
  const forcedLine = forcedToolName
    ? `You MUST call exactly the tool "${forcedToolName}" unless the user request is impossible or unsafe. Do not call any other tool first.`
    : 'Only call a tool when the user request requires an external action.';
  const parallelLine = parallelToolCalls
    ? 'You may emit multiple tool call blocks only when the user explicitly asks for multiple independent actions.'
    : 'Emit at most one tool call block.';

  return `[TOOL CALL CONTRACT - MUST FOLLOW]
Available tool names: ${toolList}
Format:

<tool_call>
{"name": "tool_name", "arguments": {"param_name": "value"}}
<` + `/tool_call>

Rules:
1. Use exact tool names from the list above or the full TOOLS AVAILABLE section.
2. Do not invent, guess, rename, or approximate tool names.
3. Do not output raw JSON as a tool call.
4. ${forcedLine}
5. ${parallelLine}
6. If no tool is needed, do not emit any tool call block.
7. Put only valid JSON inside each <tool_call> block. No markdown fences, comments, or explanatory text inside the block.
8. If you emit a tool call, stop after the closing </tool_call> tag and wait for the tool response.`;
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function looksLikeUnwrappedToolCall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  return /["']name["']\s*:/.test(trimmed) && /["']arguments["']\s*:/.test(trimmed);
}

export function parseUnwrappedToolCalls(text: string): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!looksLikeUnwrappedToolCall(text)) return [];

  try {
    const parsed = robustParseJSON(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter(item => item && typeof item === 'object')
      .map((item: any) => {
        const name = item.name || item.function?.name || item.tool_name || item.tool;
        if (!name || typeof name !== 'string') return null;
        return {
          id: item.id || item.tool_call_id || `call_${crypto.randomUUID()}`,
          name,
          arguments: parseToolArguments(item.arguments || item.function?.arguments || item.args || item.parameters || item.input || {}),
        };
      })
      .filter((item: any): item is { id: string; name: string; arguments: Record<string, unknown> } => item !== null);
  } catch {
    return [];
  }
}
