export function estimateTokenCount(text: string): number {
  // Divisor conservador (2.5) para evitar estouro silencioso do context window.
  // Tokenizers modernos (como o do Qwen) usam ~1.5 a 2.5 caracteres por token
  // para textos mistos (português, código, caracteres especiais).
  return Math.ceil(text.length / 2.5);
}

function truncateSemantically(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  
  const truncated = content.slice(0, maxChars);
  
  if (truncated.trimStart().startsWith('{') || truncated.trimStart().startsWith('[')) {
    const lastBrace = Math.max(truncated.lastIndexOf('}'), truncated.lastIndexOf(']'));
    if (lastBrace > maxChars * 0.7) {
      return truncated.slice(0, lastBrace + 1) + ' /* truncated */';
    }
  }
  
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxChars * 0.8) {
    return truncated.slice(0, lastNewline) + '\n[Truncated]';
  }
  
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.9) {
    return truncated.slice(0, lastSpace) + '... [Truncated]';
  }
  
  return truncated + '... [Truncated]';
}

export function truncateMessages(
  messages: Array<{ role: string; content: string | null | any[] }>,
  maxContextLength: number,
  systemPrompt: string = ''
): Array<{ role: string; content: string }> {
  const systemTokens = estimateTokenCount(systemPrompt);
  const availableTokens = maxContextLength - systemTokens - 500;
  
  if (availableTokens <= 0) {
    return [{ role: 'user', content: systemPrompt }];
  }
  
  const result: Array<{ role: string; content: string }> = [];
  let usedTokens = 0;
  
  const normalizedMessages = messages.map(msg => {
    let contentStr = '';
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || '';
    }
    return { role: msg.role, content: contentStr };
  });
  
  for (let i = normalizedMessages.length - 1; i >= 0; i--) {
    const msg = normalizedMessages[i];
    const msgTokens = estimateTokenCount(msg.content);
    
    if (usedTokens + msgTokens <= availableTokens) {
      result.push(msg);
      usedTokens += msgTokens;
    } else {
      const remainingTokens = availableTokens - usedTokens;
      if (remainingTokens > 100) {
        const maxChars = Math.floor(remainingTokens * 2.5);
        const truncatedContent = truncateSemantically(msg.content, maxChars);
        result.push({ role: msg.role, content: `[Truncated] ${truncatedContent}` });
      }
      break;
    }
  }
  
  if (result.length === 0 && normalizedMessages.length > 0) {
    const lastMsg = normalizedMessages[normalizedMessages.length - 1];
    const maxChars = Math.max(200, Math.floor(availableTokens * 2.5));
    const truncatedContent = truncateSemantically(lastMsg.content, maxChars);
    result.push({ role: lastMsg.role, content: `[Truncated] ${truncatedContent}` });
  }
  
  result.reverse();
  return result;
}
