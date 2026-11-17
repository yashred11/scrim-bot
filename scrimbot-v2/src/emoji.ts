const CUSTOM_RE = /^(a:)?(\w{2,32}):(\d{17,20})$/;
const VARIATION_SELECTOR = /\uFE0F/g;

export interface EmojiRef {
  id?: string | null;
  name?: string | null;
}

export interface ParsedEmoji {
  /** Stable identity used to match gateway events: custom:<id> or the unicode emoji without U+FE0F. */
  key: string;
  /** Text that renders the emoji inside a message. */
  display: string;
  /** Value placed in REST routes for reactions. */
  routeParam: string;
}

/** Identity of an emoji as it appears in a gateway reaction event. */
export function emojiKey(e: EmojiRef | null | undefined): string | null {
  if (!e) return null;
  if (e.id) return `custom:${e.id}`;
  if (e.name) return e.name.replace(VARIATION_SELECTOR, '');
  return null;
}

/**
 * Parses one emoji from ROLE_MAPPING. Custom emoji are matched by their ID, so renaming
 * the emoji in the server does not break the mapping.
 */
export function parseEmojiSpec(spec: string): ParsedEmoji {
  const s = spec.trim();
  if (s.length === 0) throw new Error('emoji is empty');

  const custom = CUSTOM_RE.exec(s);
  if (custom) {
    const [, animated, name, id] = custom;
    return {
      key: `custom:${id}`,
      display: `<${animated ? 'a' : ''}:${name}:${id}>`,
      routeParam: `${name}:${id}`,
    };
  }

  if (/^[\w:]+$/.test(s)) {
    throw new Error(`"${s}" looks like a custom emoji but is not written as name:id`);
  }

  return { key: s.replace(VARIATION_SELECTOR, ''), display: s, routeParam: encodeURIComponent(s) };
}
