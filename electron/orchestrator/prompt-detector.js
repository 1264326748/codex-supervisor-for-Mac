import crypto from 'node:crypto';

const CONFIRM_PATTERNS = [
  /\b1\s*[\).:-]?\s*yes\b/i,
  /\b2\s*[\).:-]?\s*yes\b.*don['’]?t\s+ask\s+again/i,
  /\b3\s*[\).:-]?\s*no\b.*tell\s+codex\s+what\s+to\s+do/i,
];

const YES_NO_PATTERN = /\b(yes|no)\b/i;
const CONTINUE_SUGGESTION_PATTERNS = [
  /如果你要/i,
  /如果你愿意/i,
  /如果需要我可以继续/i,
  /下一步可以继续/i,
  /要的话我可以继续/i,
  /if you want/i,
  /if you'd like/i,
  /i can continue/i,
  /i can proceed/i,
  /next step.*(?:continue|proceed)/i,
];

export function detectApprovalPrompt(lines) {
  const normalized = Array.isArray(lines)
    ? lines.map((line) => String(line || '').trimEnd())
    : String(lines || '').replace(/\r/g, '').split('\n');

  const tail = normalized.slice(-30);
  const joined = tail.join('\n');
  const isThreeChoice = CONFIRM_PATTERNS.every((pattern) => pattern.test(joined));
  if (isThreeChoice) {
    const promptText = pickPromptText(tail);
    return {
      hit: true,
      kind: 'three_choice',
      promptText,
      fingerprint: buildPromptFingerprint(promptText),
      options: [1, 2, 3],
    };
  }

  const hasMaybeAskLine = tail.some((line) => {
    const row = line.toLowerCase();
    return row.includes('allow this action') || row.includes('confirm') || row.includes('[y/n') || row.includes('继续') || row.includes('确认');
  });
  if (hasMaybeAskLine && YES_NO_PATTERN.test(joined)) {
    const promptText = pickPromptText(tail);
    return {
      hit: true,
      kind: 'yes_no',
      promptText,
      fingerprint: buildPromptFingerprint(promptText),
      options: [1, 3],
    };
  }

  const hasContinueSuggestion = tail.some((line) => CONTINUE_SUGGESTION_PATTERNS.some((pattern) => pattern.test(line)));
  if (hasContinueSuggestion) {
    const promptText = pickContinueSuggestionText(tail);
    if (!promptText) {
      return {
        hit: false,
        kind: 'none',
        promptText: '',
        fingerprint: '',
        options: [],
      };
    }
    return {
      hit: true,
      kind: 'continue_suggestion',
      promptText,
      fingerprint: buildPromptFingerprint(promptText),
      options: [1, 2, 3],
    };
  }

  return {
    hit: false,
    kind: 'none',
    promptText: '',
    fingerprint: '',
    options: [],
  };
}

export function buildPromptFingerprint(text) {
  const clean = String(text || '')
    .toLowerCase()
    .replace(/\/[^\s]+/g, '<path>')
    .replace(/\d+/g, '<num>')
    .replace(/\(\s*<num>\s*s\s*\)/g, '(<duration>)')
    .replace(/<num>\s*%\s*context\s*left/g, '<context-left>')
    .replace(/context\s*left/g, '<context-left>')
    .replace(/\bworking\b/g, '<working>')
    .replace(/\s+/g, ' ')
    .trim();

  return crypto.createHash('sha256').update(clean).digest('hex').slice(0, 16);
}

function pickPromptText(lines) {
  const tail = lines.slice(-12);
  return tail
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .join('\n');
}

function pickContinueSuggestionText(lines) {
  const candidates = lines
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .filter((line) => CONTINUE_SUGGESTION_PATTERNS.some((pattern) => pattern.test(line)));

  if (candidates.length === 0) {
    return '';
  }

  return candidates.slice(-2).join('\n');
}
