export const args = process.argv.slice(2);

export function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export function hasFlag(name) { return args.includes(`--${name}`); }
