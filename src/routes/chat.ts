/*
 * File: chat.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createQwenStream, updateSessionParent } from '../services/qwen.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { QwenStreamParser, ParsedChunkResult } from '../utils/qwen-stream-parser.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import { getModelContextWindow } from '../core/model-registry.js'
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.ts';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.ts';
import { registerStream, removeStream, getStream } from '../core/stream-registry.ts';
import { metrics } from '../core/metrics.js'

export interface DeltaResult {
  delta: string;
  matchedContent: string;
}

export function getIncrementalDelta(oldStr: string, newStr: string): DeltaResult {
  if (!oldStr) {
    return { delta: newStr, matchedContent: newStr };
  }
  if (newStr === oldStr) {
    return { delta: '', matchedContent: oldStr };
  }

  // Fast path: incremental SSE streams append to oldStr most of the time
  if (newStr.startsWith(oldStr)) {
    const delta = newStr.slice(oldStr.length);
    if (delta.length <= 4 && oldStr.length > 2000) {
      return { delta: newStr, matchedContent: oldStr + newStr };
    }
    return { delta, matchedContent: newStr };
  }

  // Fallback: segment-based prefix matching
  const scanWindow = Math.min(2000, oldStr.length);
  const maxLen = Math.min(scanWindow, newStr.length);

  let commonPrefixLen = 0;
  const segmentLen = 64;
  while (commonPrefixLen + segmentLen <= maxLen) {
    if (oldStr.slice(commonPrefixLen, commonPrefixLen + segmentLen) !==
        newStr.slice(commonPrefixLen, commonPrefixLen + segmentLen)) {
      break;
    }
    commonPrefixLen += segmentLen;
  }

  // Fine-grained scan within the mismatching segment
  while (commonPrefixLen < maxLen && oldStr[commonPrefixLen] === newStr[commonPrefixLen]) {
    commonPrefixLen++;
  }

  const threshold = Math.min(scanWindow, 4);
  if (commonPrefixLen >= threshold) {
    return { delta: newStr.substring(commonPrefixLen), matchedContent: newStr };
  }

  return { delta: newStr, matchedContent: oldStr + newStr };
}

function parseQwenErrorPayload(raw: string): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith('data: ')) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : (code === 'Not_Found' ? 404 : 502);
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : (payload.error.message || JSON.stringify(payload.error));
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    // Non-SSE, non-JSON upstream body. Keep this as an explicit bad gateway
    // instead of silently returning an empty assistant message.
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }

  return null;
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    
    // Extract the prompt
    let prompt = '';
    const messages = body.messages || [];
    let systemPrompt = '';
    const pendingMultimodal: Array<Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }>> = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        // Handle multimodal content (text + images + videos + audio + files)
        const multimodalParts = msg.content.filter(
          (p: any) =>
            (p.type === "image_url" && p.image_url?.url) ||
            (p.type === "video_url" && p.video_url?.url) ||
            (p.type === "audio_url" && p.audio_url?.url) ||
            (p.type === "file_url" && p.file_url?.url),
        );

        if (multimodalParts.length > 0) {
          // Defer processing to after account selection to reuse cached headers
          pendingMultimodal.push(multimodalParts);
          // Extract text parts for prompt building
          contentStr = msg.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n");
        } else {
          // No multimodal parts, just extract text
          contentStr = msg.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n");
        }
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system') {
        systemPrompt += (contentStr || '') + '\n\n';
      } else if (msg.role === 'user') {
        prompt += `User: ${contentStr || ''}\n\n`;
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr || '';
        const reasoning = (msg as any).reasoning_content;
        if (reasoning) {
          assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
             const args = tc.function?.arguments;
             let parsedArgs: any = {};
             if (typeof args === 'string') {
               try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
             } else if (args && typeof args === 'object') {
               parsedArgs = args;
             }
             const payload = { name: tc.function?.name, arguments: parsedArgs };
             const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
             assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim();
           }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let toolName = msg.name;
        if (!toolName && msg.tool_call_id) {
          // Look up tool name in history by tool_call_id
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j];
            if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
              const call = prevMsg.tool_calls.find(tc => tc.id === msg.tool_call_id);
              if (call) {
                toolName = call.function?.name;
                break;
              }
            }
          }
        }
        prompt += `Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n`;
      }
    }

    // Inject tools instructions
    const bodyAny = body as any;
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      // Better formatting for tools
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in <tool_call> tags:\n\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n6. NEVER invent, guess, or hallucinate tool names. You MUST ONLY use the exact tool names provided in the 'TOOLS AVAILABLE' list above. Calling an unlisted tool will result in a hard execution error.\n\n`;
      
      if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    const modelId = body.model.replace('-no-thinking', '');
    const modelContextWindow = getModelContextWindow(modelId)
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt);
    const hasTools = Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0;
    
    let finalPrompt: string;
    if (estimatedTokens > modelContextWindow - 1000) {
      const truncated = truncateMessages(messages, modelContextWindow, systemPrompt);
      const truncatedBody = truncated.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n');
      finalPrompt = systemPrompt ? `${systemPrompt}\n\n${truncatedBody}` : truncatedBody;
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    // Reforço de instrução de tool call para contextos longos (mitiga "Lost in the Middle")
    if (hasTools && estimatedTokens > 15000) {
      finalPrompt += '\n\n[CRITICAL REMINDER: You MUST use the exact <tool_call> JSON format specified in the system instructions. Do not hallucinate tool names or output raw JSON without the tags.]';
    }

    const isThinkingModel = !body.model.includes('no-thinking');
    
    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !messages.some(m => m.role === 'assistant');

    // Account selection with fallback on rate-limit/failure
    let account = getNextAccount();
    let triedAccountIds = new Set<string>();
    let lastError: any = null;

    let stream: ReadableStream | undefined;
    let uiSessionId = '';
    const completionId = 'chatcmpl-' + uuidv4();

    while (account) {
      const accountId = account.id;
      const accountEmail = account.email;

      if (triedAccountIds.has(accountId)) {
        account = getNextAvailableAccount(accountId);
        continue;
      }
      triedAccountIds.add(accountId);

      const cooldownInfo = getAccountCooldownInfo(accountId);
      if (cooldownInfo && accountId !== 'global') {
        console.log(`[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
        account = getNextAvailableAccount(accountId);
        continue;
      }

      console.log(`[Chat] Routing request to account: ${accountEmail} (${accountId})`);

      let retries = 3;
      let retryDelay = 500;
      let success = false;

      while (retries > 0) {
        try {
          const result = await createQwenStream(
            finalPrompt,
            isThinkingModel,
            body.model,
            null, // Always force new chat for concurrency isolation
            accountId === 'global' ? undefined : accountId,
            undefined,
            pendingMultimodal.length > 0 ? pendingMultimodal : undefined
          );
            stream = result.stream;
            uiSessionId = result.uiSessionId;
            registerStream(completionId, {
              abortController: result.controller,
              accountId: result.accountId,
              uiSessionId: result.uiSessionId,
              targetResponseId: '',
              headers: result.headers,
            });
            success = true;
            break;
        } catch (err: any) {
          retries--;

          if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
            const hourHint = err.message?.match(/Wait about (\d+) hour/);
            const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
            markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
            console.warn(`[Chat] Account ${accountEmail} (${accountId}) rate-limited. Marked for cooldown.`);
            lastError = err;
            break;
          }

          if (retries === 0) {
            if (err.upstreamStatus && err.upstreamStatus >= 500) {
              markAccountRateLimited(accountId, undefined, 'ServerError');
              console.warn(`[Chat] Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`);
            }
            lastError = err;
            break;
          }

          let useDelay = retryDelay;
          if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
            useDelay = err.retryAfterMs;
          }
          const isRetryable = err instanceof RetryableQwenStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
          if (!isRetryable) {
            lastError = err;
            break;
          }
          console.warn(`[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
          await new Promise(r => setTimeout(r, useDelay));
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
      }

      if (success) {
        break;
      }

      account = getNextAvailableAccount(accountId);
    }

    if (!stream) {
      removeStream(completionId);
      throw lastError || new Error('All accounts failed');
    }

    if (!isStream) {
      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      const toolCallsOut: any[] = [];
      let buffer = '';
      const hasTools = Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0;

      const qwenParser = new QwenStreamParser(uiSessionId, {
        tools: hasTools ? bodyAny.tools : [],
        onThinking: (content: string) => {
          // Accumulate reasoning content (handled via parser state)
        },
        onToolCall: (tc) => {
          toolCallsOut.push({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments)
            }
          });
        },
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          qwenParser.parseLine(dataStr);
        }
      }

      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        removeStream(completionId);
        return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
      }

      const { text: remainingText, toolCalls: remainingToolCalls } = qwenParser.flush();
      const parserState = qwenParser.state;
      let finalContent = parserState.lastFullContent;
      if (remainingText) {
        finalContent += remainingText;
      }
      for (const tc of remainingToolCalls) {
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        });
      }

      const usage = {
        prompt_tokens: parserState.promptTokens,
        completion_tokens: parserState.completionTokens,
        total_tokens: parserState.promptTokens + parserState.completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : finalContent };
      if (parserState.reasoningBuffer) message.reasoning_content = parserState.reasoningBuffer;
      if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
      if (toolCallsOut.length) message.tool_calls = toolCallsOut;

      removeStream(completionId);
      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop'
        }],
        usage
      });
    }

    // Disable Nagle's algorithm to transmit small chunks immediately without buffering delay
    const socket = (c.env as any)?.incoming?.socket || (c.req.raw as any).socket;
    if (socket && typeof socket.setNoDelay === 'function') {
      socket.setNoDelay(true);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    return honoStream(c, async (streamWriter: any) => {
      let heartbeatInterval: any;
      try {
        // Send heartbeat to prevent Cloudflare 524 timeout
        await streamWriter.write(': heartbeat\n\n');

        // Set up a periodic heartbeat to keep the connection alive during long thinking phases
        heartbeatInterval = setInterval(async () => {
          try {
            await streamWriter.write(': keep-alive\n\n');
          } catch (e) {
            clearInterval(heartbeatInterval);
          }
        }, 15000); // Every 15 seconds

        // Optimized: fire-and-forget write (Hono's streamWriter has internal buffering)
        const writeEvent = (data: any) => {
          streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const makeChoice = (delta: any, finishReason: string | null = null) => ({
          index: 0,
          delta,
          logprobs: null,
          finish_reason: finishReason
        });

        // Pre-compute timestamp once before the stream loop
        const createdTimestamp = Math.floor(Date.now() / 1000);

        // Send initial chunk
        writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: body.model,
          choices: [makeChoice({ role: 'assistant', content: '' })]
        });

        const reader = stream.getReader();
        const decoder = new TextDecoder();

        let reasoningBuffer = '';
        let lastFullContent = '';
        let targetResponseId: string | null = null;
        let targetResponseIdSet = false;
        let currentThoughtIndex = 0;
        const hasTools = Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0;
        const toolParser = hasTools ? new StreamingToolParser(bodyAny.tools) : null;

        let buffer = '';
        let completionTokens = 0;
        let promptTokens = Math.ceil(finalPrompt.length / 3.5);

        // Real-time flush: send each event immediately to minimize latency
        let chunkCount = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

           let startIdx = 0;
           let newlineIdx: number;
           while ((newlineIdx = buffer.indexOf('\n', startIdx)) !== -1) {
             const line = buffer.slice(startIdx, newlineIdx);
             startIdx = newlineIdx + 1;

             const trimmed = line.trim();
             if (!trimmed || !trimmed.startsWith('data: ')) continue;

             const dataStr = trimmed.slice(6);
             if (dataStr === '[DONE]') {
               streamWriter.write('data: [DONE]\n\n');
               continue;
             }

            try {
              const chunk = JSON.parse(dataStr);

              // Extract response_id for session tracking and target filtering
              if (chunk['response.created'] && chunk['response.created'].response_id) {
                if (!targetResponseId) {
                  targetResponseId = chunk['response.created'].response_id;
                  targetResponseIdSet = true;
                }
                updateSessionParent(uiSessionId, chunk['response.created'].response_id);
              } else if (chunk.response_id && !targetResponseIdSet) {
                targetResponseId = chunk.response_id;
                targetResponseIdSet = true;
                updateSessionParent(uiSessionId, chunk.response_id);
              }

              if (chunk.usage) {
                if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
                if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
              }

              let vStr = '';
              let foundStr = false;
              let isThinkingChunk = false;

              if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                  (!targetResponseIdSet || chunk.response_id === targetResponseId)) {
                const delta = chunk.choices[0].delta;

                if (delta.phase === 'thinking_summary') {
                  isThinkingChunk = true;
                  if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                    const thoughts = delta.extra.summary_thought.content;
                    if (thoughts.length > currentThoughtIndex) {
                      vStr = thoughts.slice(currentThoughtIndex).join('\n');
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  }
                } else if (delta.phase === 'answer') {
                  isThinkingChunk = false;
                  if (delta.content !== undefined) {
                    const newContent = delta.content || '';
                    const result = getIncrementalDelta(lastFullContent, newContent);
                    vStr = result.delta;
                    if (vStr) {
                      lastFullContent = result.matchedContent;
                      foundStr = true;
                    }
                  }
                }
              }

              if (foundStr && vStr !== '') {
        if (vStr === 'FINISHED') continue;

                if (isThinkingChunk) {
                  reasoningBuffer += vStr;
                  streamWriter.write(`data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: createdTimestamp,
                    model: body.model,
                    choices: [makeChoice({ reasoning_content: vStr })]
                  })}\n\n`);
                } else {
                  if (hasTools && toolParser) {
                    const { text, toolCalls } = toolParser.feed(vStr);
                    if (text) {
                      streamWriter.write(`data: ${JSON.stringify({
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: createdTimestamp,
                        model: body.model,
                        choices: [makeChoice({ content: text })]
                      })}\n\n`);
                    }
                    for (const tc of toolCalls) {
                      streamWriter.write(`data: ${JSON.stringify({
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: createdTimestamp,
                        model: body.model,
                        choices: [makeChoice({
                          tool_calls: [{
                            index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                            id: tc.id,
                            type: 'function',
                            function: {
                              name: tc.name,
                              arguments: JSON.stringify(tc.arguments)
                            }
                          }]
                        })]
                      })}\n\n`);
                    }
                  } else {
                    if (vStr) {
                      streamWriter.write(`data: ${JSON.stringify({
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: createdTimestamp,
                        model: body.model,
                        choices: [makeChoice({ content: vStr })]
                      })}\n\n`);
                    }
                  }
                }
              }
            } catch (e) {
              // parse error, ignore partial chunk
            }
          }

          // Trim processed portion from buffer
          if (startIdx > 0) {
            buffer = buffer.slice(startIdx);
          }

          // Periodic yielding to prevent event loop starvation
          chunkCount++;
          if (chunkCount % 100 === 0) {
            await new Promise(r => setTimeout(r, 0));
          }
        }

        const upstreamError = parseQwenErrorPayload(buffer);
        if (upstreamError) {
          writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTimestamp,
            model: body.model,
            choices: [makeChoice({ content: upstreamError.message })]
          });
          writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTimestamp,
            model: body.model,
            choices: [makeChoice({}, 'stop')]
          });
          streamWriter.write('data: [DONE]\n\n');
          return;
        }

        if (toolParser) {
          const flushResult = toolParser.flush();

          if (flushResult.text) {
            writeEvent({
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdTimestamp,
              model: body.model,
              choices: [makeChoice({ content: flushResult.text })]
            });
          }
          for (const tc of flushResult.toolCalls) {
            const idx = toolParser.getEmittedToolCallCount() - flushResult.toolCalls.length + flushResult.toolCalls.indexOf(tc);
            writeEvent({
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdTimestamp,
              model: body.model,
              choices: [makeChoice({
                tool_calls: [{
                  index: idx,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments)
                  }
                }]
              })]
            });
          }
        }

        const usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          prompt_tokens_details: { cached_tokens: 0 }
        };

        const finalFinishReason = toolParser && toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';

        writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: body.model,
          choices: [makeChoice({}, finalFinishReason)],
          ...(body.stream_options?.include_usage ? {} : { usage })
        });

        if (body.stream_options?.include_usage) {
          writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTimestamp,
            model: body.model,
            choices: [],
            usage
          });
        }
        streamWriter.write('data: [DONE]\n\n');

      } finally {
        clearInterval(heartbeatInterval);
        removeStream(completionId);
      }
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err)
    const status = err.upstreamStatus || 500
    if (status >= 500) {
      metrics.increment('requests.errors')
    }
    return c.json({ error: { message: err.message } }, status)
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id } = body;

    if (!chat_id || !response_id) {
      return c.json({ error: 'chat_id and response_id are required' }, 400);
    }

    const stream = getStream(chat_id);
    if (!stream) {
      return c.json({ error: 'Stream not found' }, 404);
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json({ error: 'response_id mismatch' }, 400);
    }

    const stopResponse = await fetch(`https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${chat_id}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Content-Type': 'application/json',
        'Cookie': stream.headers.cookie,
        'Origin': 'https://chat.qwen.ai',
        'Referer': `https://chat.qwen.ai/c/${chat_id}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': stream.headers['user-agent'],
        'X-Request-Id': uuidv4(),
        'bx-ua': stream.headers['bx-ua'],
        'bx-umidtoken': stream.headers['bx-umidtoken'],
        'bx-v': stream.headers['bx-v'],
      },
      body: JSON.stringify({ chat_id, response_id }),
    });

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error(`[Stop] Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`);
      return c.json({ error: 'Failed to stop generation' }, stopResponse.status as any);
    }

    stream.abortController.abort();
    removeStream(chat_id);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error('Error in chatCompletionsStop:', err);
    return c.json({ error: err.message }, 500);
  }
}
