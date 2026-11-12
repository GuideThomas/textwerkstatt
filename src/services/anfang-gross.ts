/**
 * Eine Artikelbezeichnung beginnt in jeder Sprache groß (Thomas, 05.11.2026). Glossareinträge stehen klein, damit sie mitten
 * im Namen klein bleiben; am Anfang setzt DeepL sie meist selbst groß, gemessen in 709 von 720 Namen. Das hier fängt den Rest.
 *
 * Beginnt die Quelle klein („eloxiert“, ein Teil einer Aufzählung), bleibt das Ziel, wie es ist. Beginnt sie mit einer Zahl,
 * zählt das wie groß: „10er Set“ wird „Sada 10 ks“, nicht „sada 10 ks“. Markup bleibt unberührt.
 */
export function anfangWieQuelle(quelle: string, ziel: string): string {
  if (/^\s*</.test(ziel) || /^\s*</.test(quelle)) return ziel;
  const erstes = quelle.match(/[\p{L}\p{N}]/u)?.[0];
  if (!erstes || /\p{Ll}/u.test(erstes)) return ziel;
  const treffer = ziel.match(/^([^\p{L}\p{N}]*)(\p{Ll})/u);
  if (!treffer) return ziel;
  return treffer[1] + treffer[2].toLocaleUpperCase() + ziel.slice(treffer[0].length);
}
