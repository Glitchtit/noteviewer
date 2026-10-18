const SIZE = /^\s*(\d+)(?:x(\d+))?\s*$/;

/**
 * Obsidian image sizing: `|300` sets the width, `|300x200` width and height.
 * Anything else after the pipe is a caption/alt text, not a size.
 */
export function parseImageSize(spec: string | undefined): { width?: number; height?: number } | undefined {
  const m = spec === undefined ? null : SIZE.exec(spec);
  if (!m) return undefined;
  return { width: Number(m[1]), ...(m[2] ? { height: Number(m[2]) } : {}) };
}

/** Splits a markdown image alt like `logo|120` into alt text and size. */
export function splitImageAlt(alt: string): { alt: string; size?: { width?: number; height?: number } } {
  const i = alt.lastIndexOf('|');
  const size = i === -1 ? undefined : parseImageSize(alt.slice(i + 1));
  return size ? { alt: alt.slice(0, i).trim(), size } : { alt };
}
