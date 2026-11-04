const tokenPattern = /@resource\(([^)]*)\)/g;
const aliasPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function findResourceAliases(textFiles: string[]): string[] {
  const aliases = new Set<string>();
  for (const text of textFiles) {
    for (const match of text.matchAll(tokenPattern)) {
      if (!aliasPattern.test(match[1])) {
        throw new Error('Invalid resource alias');
      }
      aliases.add(match[1]);
    }
  }
  return [...aliases];
}

export function rewriteResourceTokens(
  text: string,
  aliasToInternalPath: Record<string, string>,
): string {
  return text.replace(tokenPattern, (_token, alias: string) => {
    if (!aliasPattern.test(alias) || !Object.hasOwn(aliasToInternalPath, alias)) {
      throw new Error('Invalid resource alias');
    }
    return aliasToInternalPath[alias];
  });
}
