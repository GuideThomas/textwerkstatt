/**
 * Wort-Level-Diff zwischen Original-Uebersetzung und korrigiertem Text.
 *
 * Hand-rolled LCS-Algorithmus — keine externe Diff-Library noetig.
 * Ergebnis: durchgestrichene rote Worte (entfernt) + gruene Worte (hinzugefuegt).
 * Reicht voellig fuer Reviewer-Korrekturen einzelner Saetze.
 */

import { useTranslation } from 'react-i18next';

interface Props {
  original: string;
  current: string;
}

interface DiffPart {
  type: 'equal' | 'removed' | 'added';
  text: string;
}

function tokenize(text: string): string[] {
  // Worte + Whitespace+Punktuation getrennt halten, damit Layout erhalten bleibt
  return text.match(/\S+|\s+/g) || [];
}

function diffWords(a: string[], b: string[]): DiffPart[] {
  // Klassischer LCS (Dynamic Programming) — fuer kurze Texte ausreichend
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const parts: DiffPart[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      parts.unshift({ type: 'equal', text: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      parts.unshift({ type: 'removed', text: a[i - 1] });
      i--;
    } else {
      parts.unshift({ type: 'added', text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    parts.unshift({ type: 'removed', text: a[--i] });
  }
  while (j > 0) {
    parts.unshift({ type: 'added', text: b[--j] });
  }

  // Aufeinanderfolgende Parts gleichen Typs zusammenfassen (lesbarer)
  const merged: DiffPart[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && last.type === p.type) last.text += p.text;
    else merged.push({ ...p });
  }
  return merged;
}

/** Nur die Wort-Hervorhebung, ohne Rahmen — auch im Versionsvergleich verwendet. */
export function WordDiff({ original, current }: Props) {
  const parts = diffWords(tokenize(original), tokenize(current));
  return (
    <>
      {parts.map((p, idx) => {
        if (p.type === 'equal') return <span key={idx}>{p.text}</span>;
        if (p.type === 'removed')
          return (
            <span key={idx} className="bg-red-100 text-red-700 line-through px-0.5 rounded-sm">
              {p.text}
            </span>
          );
        return (
          <span key={idx} className="bg-green-100 text-green-800 px-0.5 rounded-sm">
            {p.text}
          </span>
        );
      })}
    </>
  );
}

export default function DiffView({ original, current }: Props) {
  const { t } = useTranslation('review');
  if (!original || original === current) return null;

  return (
    <div className="mt-2 px-3 py-2 bg-purple-50/60 border border-purple-200 rounded text-xs">
      <div className="text-[10px] uppercase tracking-wide text-purple-700 font-semibold mb-1">
        {t('diff.title')}
      </div>
      <div className="text-gray-800 break-words leading-relaxed">
        <WordDiff original={original} current={current} />
      </div>
    </div>
  );
}
