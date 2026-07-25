const CLAIM_PATTERN = /\b(?:i(?:['’]m| am|['’]ll| will)?\s+(?:work(?:ing)?|tak(?:e|ing)|claim|implement|handl(?:e|ing))(?:\s+on)?\s+(?:this|it)|i(?:['’]d| would)\s+(?:like|love|be happy)\s+to\s+(?:(?:work|take)\s+(?:on\s+)?|claim|implement|investigate)(?:this(?:\s+one|\s+issue)?|it)?|i(?:['’]m| am)\s+applying\s+to\s+work\s+on\s+this(?:\s+issue)?|i(?:['’]ve| have)\s+(?:applied\s+to\s+work\s+on\s+this(?:\s+issue)?|implemented|completed|fixed|added)\b|i\s+can\s+(?:take|implement)\s+this(?:\s+issue)?|i\s+will\s+handle\s+this(?:\s+issue)?|let\s+me\s+(?:take|handle)\s+this(?:\s+one|\s+issue)?|(?:i\s+)?would\s+love\s+to\s+work\s+on\s+(?:this|it)|(?:can\s+i|i\s+can)\s+work\s+on\s+(?:this|it)|could\s+i\s+be\s+assigned\b|please assign (?:this|it|me)|assign me(?:\s+(?:please|pls))?|(?:request(?:ing)?\s+(?:that\s+)?(?:this\s+issue|this|it)\s+be\s+assigned\s+to\s+me)|working on this|this(?:\s+one)?\s+is\s+yours\s+if\s+you\s+want\s+it|i opened (?:a )?pr|i have (?:a )?pr|(?:please|kindly) merge (?:my )?pr\s*#?\d+)\b/i;
const APPLICATION_PATTERN = /@[a-z0-9](?:[a-z0-9-]{0,38})\s+has\s+applied\s+to\s+work\s+on\s+this\s+issue\b/i;

export function isClaimText(value) {
  const text = String(value ?? '');
  return CLAIM_PATTERN.test(text) || APPLICATION_PATTERN.test(text);
}
