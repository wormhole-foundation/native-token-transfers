/*  Simple ANSI color utilities */

const RESET = "\x1b[0m";

const useColors =
  process.env.NO_COLOR === undefined &&
  (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY);

const c = (code: string) => (text: unknown) =>
  useColors ? `${code}${text}${RESET}` : String(text);

export const colors = {
  red: c("\x1b[31m"),
  green: c("\x1b[32m"),
  yellow: c("\x1b[33m"),
  blue: c("\x1b[34m"),
  cyan: c("\x1b[36m"),
  white: c("\x1b[37m"),
  gray: c("\x1b[90m"),
  dim: c("\x1b[2m"),
  reset: (text: unknown) => String(text),
};

export default colors;
