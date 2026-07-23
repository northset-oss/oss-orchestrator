const CLAIM_PATTERN = /\b(?:i(?:['’]m| am|['’]ll| will)?\s+(?:work(?:ing)?|take|claim|implement)(?:\s+on)?\s+(?:this|it)|i(?:['’]d| would)\s+like\s+to\s+(?:work\s+on|take|claim|implement)\s+(?:this(?:\s+one)?|it)|i(?:['’]d| would)\s+love\s+to\s+(?:investigate|work\s+on)\b|i(?:['’]ve| have)\s+(?:implemented|completed|fixed|added)\b|(?:i\s+)?would\s+love\s+to\s+work\s+on\s+(?:this|it)|(?:can\s+i|i\s+can)\s+work\s+on\s+(?:this|it)|could\s+i\s+be\s+assigned\b|please assign (?:this|it|me)|assign me(?:\s+(?:please|pls))?|(?:request(?:ing)?\s+(?:that\s+)?(?:this\s+issue|this|it)\s+be\s+assigned\s+to\s+me)|working on this|this(?:\s+one)?\s+is\s+yours\s+if\s+you\s+want\s+it|i opened (?:a )?pr|i have (?:a )?pr|(?:please|kindly) merge (?:my )?pr\s*#?\d+)\b/i;

export function isClaimText(value) {
  return CLAIM_PATTERN.test(String(value ?? ''));
}
