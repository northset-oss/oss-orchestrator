const CLAIM_PATTERN = /\b(?:i(?:['’]m| am|['’]ll| will)?\s+(?:work(?:ing)?|take|claim|implement)(?:\s+on)?\s+(?:this|it)|i(?:['’]d| would)\s+like\s+to\s+(?:work\s+on|take|claim|implement)\s+(?:this(?:\s+one)?|it)|(?:i\s+)?would\s+love\s+to\s+work\s+on\s+(?:this|it)|(?:can\s+i|i\s+can)\s+work\s+on\s+(?:this|it)|please assign (?:this|it|me)|working on this|this(?:\s+one)?\s+is\s+yours\s+if\s+you\s+want\s+it|i opened (?:a )?pr|i have (?:a )?pr)\b/i;

export function isClaimText(value) {
  return CLAIM_PATTERN.test(String(value ?? ''));
}
