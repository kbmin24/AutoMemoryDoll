import type { Completion } from '@codemirror/autocomplete';
import { LanguageSupport } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { jinja } from '@codemirror/lang-jinja';
import { latexLanguage } from 'codemirror-lang-latex';

export type CodeLanguage = 'latex' | 'jinja-latex' | 'javascript';

const latexSupport = new LanguageSupport(latexLanguage);
export const codeLanguages: Record<CodeLanguage, LanguageSupport> = {
  latex: latexSupport,
  'jinja-latex': jinja({ base: latexSupport }),
  javascript: javascript(),
};

export function codeLanguageSupport(
  lang: CodeLanguage,
  variables: readonly Completion[] = [],
): LanguageSupport {
  if (lang === 'jinja-latex' && variables.length) {
    return jinja({ base: latexSupport, variables });
  }
  return codeLanguages[lang];
}

export function codeLanguageForFile(
  segments: readonly string[],
): CodeLanguage | undefined {
  if (segments.length === 1 && segments[0] === 'template.tex')
    return 'jinja-latex';
  const extension = segments.at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
  if (
    ['tex', 'ltx', 'cls', 'sty', 'dtx', 'ins', 'def', 'clo'].includes(extension)
  )
    return 'latex';
  if (['json', 'jsonc', 'js', 'mjs', 'cjs'].includes(extension))
    return 'javascript';
  return undefined;
}
