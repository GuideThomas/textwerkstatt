/**
 * Skizzen-Hintergrund des Atelier-Themas, Motiv „Computational“ (TW-CD-Guide §6): Graph, Pipeline, Klammern, Kurven.
 * Übernommen aus scripts/blog/templates/index.html (Hauptrepo, 12.11.2026), dort als statisches SVG.
 * Fest hinter allem (`.tw-skizzen` in thema.css), ohne Zeiger, im Druck aus; am Handy nur die Motive ohne `md:`.
 */
export default function Skizzen() {
  return (
    <div className="tw-skizzen" aria-hidden="true">
      <svg
        viewBox="0 0 1600 1000"
        preserveAspectRatio="xMidYMid slice"
        width="100%"
        height="100%"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
      {/* 1. Knoten-Kanten-Graph (Oben links, auch mobil sichtbar) */}
        <g transform="translate(38, 32)">
          <line x1="18" y1="88" x2="225" y2="88" strokeWidth="0.55" strokeDasharray="7 4 2 4" />
          <line x1="112" y1="6" x2="112" y2="178" strokeWidth="0.55" strokeDasharray="7 4 2 4" />
          {/* Kanten mit Bleistift-Überschwüngen */}
          <line x1="42" y1="54" x2="116" y2="34" strokeWidth="1.2" />
          <line x1="40" y1="56" x2="114" y2="112" strokeWidth="1.1" />
          <line x1="112" y1="36" x2="188" y2="66" strokeWidth="1.3" />
          <line x1="112" y1="34" x2="112" y2="114" strokeWidth="0.9" strokeDasharray="4 3" />
          <line x1="110" y1="110" x2="186" y2="64" strokeWidth="1.1" />
          <line x1="110" y1="110" x2="168" y2="148" strokeWidth="1.2" />
          <line x1="184" y1="62" x2="164" y2="150" strokeWidth="0.85" />
          {/* Knoten (Doppelstriche) */}
          <circle cx="44" cy="54" r="14" strokeWidth="1.6" />
          <ellipse cx="44" cy="54" rx="15.5" ry="13.5" strokeWidth="0.75" transform="rotate(-8 44 54)" />
          <circle cx="112" cy="36" r="11" strokeWidth="1.5" />
          <circle cx="112" cy="110" r="16" strokeWidth="1.7" />
          <ellipse cx="112" cy="110" rx="17" ry="15" strokeWidth="0.8" transform="rotate(6 112 110)" />
          <circle cx="184" cy="64" r="13" strokeWidth="1.5" />
          <circle cx="166" cy="146" r="10" strokeWidth="1.4" />
          {/* Maßlinie unten */}
          <line x1="30" y1="158" x2="30" y2="186" strokeWidth="0.6" />
          <line x1="196" y1="158" x2="196" y2="186" strokeWidth="0.6" />
          <line x1="24" y1="178" x2="202" y2="178" strokeWidth="0.75" />
          <path d="M37 175 L30 178 L37 181 M189 175 L196 178 L189 181" strokeWidth="0.85" />
        </g>

        {/* 2. Datenfluss-Pipeline mit Kästchen und Pfeilen (Mitte-oben links) */}
        <g className="hidden md:inline" transform="translate(32, 295)">
          <line x1="108" y1="-8" x2="108" y2="235" strokeWidth="0.55" strokeDasharray="6 4 2 4" />
          {/* Kästchen 1 mit Überschwüngen */}
          <path d="M44 14 L174 14 M48 48 L172 48 M48 10 L48 52 M168 10 L168 52" strokeWidth="1.5" />
          <path d="M46 16 L170 15 L169 49 L47 47 Z" strokeWidth="0.75" />
          {/* Pfeil 1 -> 2 */}
          <line x1="108" y1="48" x2="108" y2="88" strokeWidth="1.3" />
          <path d="M103 80 L108 88 L113 80" strokeWidth="1.2" />
          {/* Kästchen 2 */}
          <path d="M36 88 L180 88 M40 126 L178 126 M40 84 L40 130 M176 84 L176 130" strokeWidth="1.6" />
          <line x1="54" y1="103" x2="142" y2="103" strokeWidth="0.9" />
          <line x1="54" y1="113" x2="118" y2="113" strokeWidth="0.8" />
          {/* Pfeil 2 -> 3 */}
          <line x1="108" y1="126" x2="108" y2="166" strokeWidth="1.3" />
          <path d="M103 158 L108 166 L113 158" strokeWidth="1.2" />
          {/* Kästchen 3 */}
          <path d="M48 166 L168 166 M50 200 L166 200 M52 162 L52 204 M164 162 L164 204" strokeWidth="1.5" />
          {/* Gestrichelte Rückkopplung (Prüfschleife) */}
          <path d="M176 107 L206 107 L206 31 L172 31" strokeWidth="0.85" strokeDasharray="5 4" />
          <path d="M179 27 L172 31 L179 35" strokeWidth="0.85" />
          {/* Höhenmaß links */}
          <line x1="18" y1="14" x2="18" y2="200" strokeWidth="0.65" />
          <line x1="12" y1="14" x2="26" y2="14" strokeWidth="0.75" />
          <line x1="12" y1="200" x2="26" y2="200" strokeWidth="0.75" />
        </g>

        {/* 3. Geschweifte Klammern mit angedeuteten Codezeilen (Mitte-unten links) */}
        <g className="hidden md:inline" transform="translate(42, 555)">
          {/* Linke geschweifte Klammer (Doppelstrich) */}
          <path d="M36 12 C22 12 20 20 20 38 L20 68 C20 78 12 82 6 82 C12 82 20 86 20 96 L20 126 C20 144 22 152 36 152" strokeWidth="1.6" />
          <path d="M38 14 C25 14 22 22 22 39 L22 69 C22 77 15 82 9 82 C15 82 22 87 22 95 L22 125 C22 142 25 150 38 150" strokeWidth="0.75" />
          {/* Einrückungs-Hilfslinien */}
          <line x1="48" y1="18" x2="48" y2="146" strokeWidth="0.55" strokeDasharray="3 4" />
          <line x1="68" y1="42" x2="68" y2="122" strokeWidth="0.55" strokeDasharray="3 4" />
          {/* Angedeutete Codezeilen (nur Striche, keine Buchstaben) */}
          <line x1="48" y1="30" x2="118" y2="30" strokeWidth="1.5" />
          <line x1="128" y1="30" x2="162" y2="30" strokeWidth="1.1" />
          <line x1="68" y1="50" x2="174" y2="50" strokeWidth="1.3" />
          <line x1="68" y1="68" x2="136" y2="68" strokeWidth="1.4" />
          <line x1="146" y1="68" x2="188" y2="68" strokeWidth="0.95" />
          <line x1="68" y1="86" x2="154" y2="86" strokeWidth="1.3" />
          <line x1="68" y1="104" x2="122" y2="104" strokeWidth="1.2" />
          <line x1="48" y1="126" x2="104" y2="126" strokeWidth="1.5" />
          {/* Rechte geschweifte Klammer */}
          <path d="M198 12 C212 12 214 20 214 38 L214 68 C214 78 222 82 228 82 C222 82 214 86 214 96 L214 126 C214 144 212 152 198 152" strokeWidth="1.4" />
        </g>

        {/* 4. Achsenkreuz mit Kurve und Messpunkten (Unten links) */}
        <g className="hidden md:inline" transform="translate(38, 748)">
          {/* Achsen mit Überschwung und Pfeilspitzen */}
          <line x1="28" y1="196" x2="28" y2="14" strokeWidth="1.5" />
          <line x1="14" y1="182" x2="246" y2="182" strokeWidth="1.5" />
          <path d="M24 22 L28 14 L32 22 M238 178 L246 182 L238 186" strokeWidth="1.2" />
          {/* Teilstriche */}
          <path d="M23 52 L31 52 M23 94 L31 94 M23 136 L31 136 M76 178 L76 186 M128 178 L128 186 M180 178 L180 186" strokeWidth="0.85" />
          {/* Asymptote / Zielwert gestrichelt */}
          <line x1="28" y1="148" x2="236" y2="148" strokeWidth="0.65" strokeDasharray="6 4" />
          {/* Kurve (Doppelstrich) */}
          <path d="M36 42 C68 46 88 118 128 134 C164 148 198 144 232 146" strokeWidth="1.7" />
          <path d="M34 45 C70 50 90 121 130 136 C166 149 200 146 234 147" strokeWidth="0.75" />
          {/* Tangente / Konstruktionslinie */}
          <line x1="52" y1="30" x2="144" y2="162" strokeWidth="0.6" strokeDasharray="4 4" />
          {/* Messpunkte mit Projektionslinien */}
          <circle cx="76" cy="78" r="4.5" strokeWidth="1.3" />
          <line x1="76" y1="83" x2="76" y2="182" strokeWidth="0.6" strokeDasharray="3 3" />
          <circle cx="128" cy="134" r="4.5" strokeWidth="1.3" />
          <line x1="128" y1="139" x2="128" y2="182" strokeWidth="0.6" strokeDasharray="3 3" />
          <circle cx="180" cy="145" r="4.5" strokeWidth="1.3" />
          <line x1="180" y1="150" x2="180" y2="182" strokeWidth="0.6" strokeDasharray="3 3" />
        </g>

        {/* 5. Neuronale Schichten: Spalten von Kreisen mit Verbindungen (Oben rechts) */}
        <g className="hidden md:inline" transform="translate(1258, 38)">
          {/* Schicht-Achsen */}
          <line x1="36" y1="8" x2="36" y2="232" strokeWidth="0.55" strokeDasharray="6 4 2 4" />
          <line x1="136" y1="8" x2="136" y2="232" strokeWidth="0.55" strokeDasharray="6 4 2 4" />
          <line x1="236" y1="8" x2="236" y2="232" strokeWidth="0.55" strokeDasharray="6 4 2 4" />
          {/* Verbindungen Schicht 1 -> 2 */}
          <line x1="48" y1="48" x2="124" y2="34" strokeWidth="1.1" />
          <line x1="48" y1="48" x2="124" y2="84" strokeWidth="0.8" />
          <line x1="48" y1="48" x2="124" y2="134" strokeWidth="0.65" strokeDasharray="4 3" />
          <line x1="48" y1="98" x2="124" y2="34" strokeWidth="0.7" />
          <line x1="48" y1="98" x2="124" y2="84" strokeWidth="1.25" />
          <line x1="48" y1="98" x2="124" y2="134" strokeWidth="0.95" />
          <line x1="48" y1="98" x2="124" y2="184" strokeWidth="0.65" />
          <line x1="48" y1="148" x2="124" y2="84" strokeWidth="0.75" />
          <line x1="48" y1="148" x2="124" y2="134" strokeWidth="1.2" />
          <line x1="48" y1="148" x2="124" y2="184" strokeWidth="1.05" />
          <line x1="48" y1="198" x2="124" y2="134" strokeWidth="0.7" strokeDasharray="4 3" />
          <line x1="48" y1="198" x2="124" y2="184" strokeWidth="1.15" />
          {/* Verbindungen Schicht 2 -> 3 */}
          <line x1="148" y1="34" x2="224" y2="68" strokeWidth="1.15" />
          <line x1="148" y1="84" x2="224" y2="68" strokeWidth="1.3" />
          <line x1="148" y1="84" x2="224" y2="124" strokeWidth="0.85" />
          <line x1="148" y1="134" x2="224" y2="68" strokeWidth="0.7" />
          <line x1="148" y1="134" x2="224" y2="124" strokeWidth="1.35" />
          <line x1="148" y1="134" x2="224" y2="180" strokeWidth="0.9" />
          <line x1="148" y1="184" x2="224" y2="124" strokeWidth="0.8" />
          <line x1="148" y1="184" x2="224" y2="180" strokeWidth="1.2" />
          {/* Kreise Spalte 1 */}
          <circle cx="36" cy="48" r="11" strokeWidth="1.5" />
          <circle cx="36" cy="98" r="11" strokeWidth="1.5" />
          <circle cx="36" cy="148" r="11" strokeWidth="1.5" />
          <circle cx="36" cy="198" r="11" strokeWidth="1.5" />
          {/* Kreise Spalte 2 */}
          <circle cx="136" cy="34" r="11.5" strokeWidth="1.5" />
          <circle cx="136" cy="84" r="11.5" strokeWidth="1.6" />
          <ellipse cx="136" cy="84" rx="12.5" ry="11" strokeWidth="0.7" transform="rotate(-10 136 84)" />
          <circle cx="136" cy="134" r="11.5" strokeWidth="1.6" />
          <circle cx="136" cy="184" r="11.5" strokeWidth="1.5" />
          {/* Kreise Spalte 3 */}
          <circle cx="236" cy="68" r="12" strokeWidth="1.6" />
          <circle cx="236" cy="124" r="12" strokeWidth="1.7" />
          <ellipse cx="236" cy="124" rx="13" ry="11.5" strokeWidth="0.75" transform="rotate(8 236 124)" />
          <circle cx="236" cy="180" r="12" strokeWidth="1.6" />
          {/* Maßpfeile oben */}
          <line x1="36" y1="12" x2="136" y2="12" strokeWidth="0.7" />
          <line x1="136" y1="12" x2="236" y2="12" strokeWidth="0.7" />
          <path d="M43 9 L36 12 L43 15 M129 9 L136 12 L129 15 M143 9 L136 12 L143 15 M229 9 L236 12 L229 15" strokeWidth="0.8" />
        </g>

        {/* 6. Lockeres Punktgitter / Embedding-Raum (Mitte rechts — nur Punkte, kein Linien-Karo) */}
        <g className="hidden md:inline" transform="translate(1272, 365)">
          {/* Lockeres Gitter aus Punkten (Kreise ohne Gitterlinien) */}
          <circle cx="24" cy="24" r="2" strokeWidth="1.3" />
          <circle cx="68" cy="20" r="1.8" strokeWidth="1.2" />
          <circle cx="114" cy="26" r="2.2" strokeWidth="1.3" />
          <circle cx="162" cy="18" r="1.8" strokeWidth="1.2" />
          <circle cx="208" cy="28" r="2" strokeWidth="1.3" />
          <circle cx="252" cy="22" r="1.8" strokeWidth="1.2" />

          <circle cx="32" cy="64" r="1.8" strokeWidth="1.2" />
          <circle cx="76" cy="58" r="2.4" strokeWidth="1.4" />
          <circle cx="122" cy="66" r="2.6" strokeWidth="1.5" />
          <circle cx="158" cy="60" r="2.4" strokeWidth="1.4" />
          <circle cx="202" cy="68" r="1.8" strokeWidth="1.2" />
          <circle cx="246" cy="62" r="2" strokeWidth="1.3" />

          <circle cx="20" cy="106" r="2" strokeWidth="1.3" />
          <circle cx="66" cy="102" r="2.2" strokeWidth="1.3" />
          <circle cx="110" cy="98" r="2.8" strokeWidth="1.5" />
          <circle cx="148" cy="96" r="2.6" strokeWidth="1.5" />
          <circle cx="196" cy="108" r="2" strokeWidth="1.3" />
          <circle cx="242" cy="104" r="1.8" strokeWidth="1.2" />

          <circle cx="28" cy="148" r="1.8" strokeWidth="1.2" />
          <circle cx="74" cy="144" r="2" strokeWidth="1.3" />
          <circle cx="118" cy="152" r="1.8" strokeWidth="1.2" />
          <circle cx="166" cy="142" r="2.2" strokeWidth="1.3" />
          <circle cx="212" cy="150" r="2.4" strokeWidth="1.4" />
          <circle cx="254" cy="146" r="1.8" strokeWidth="1.2" />

          <circle cx="22" cy="188" r="2" strokeWidth="1.3" />
          <circle cx="70" cy="192" r="1.8" strokeWidth="1.2" />
          <circle cx="116" cy="186" r="2" strokeWidth="1.3" />
          <circle cx="164" cy="194" r="1.8" strokeWidth="1.2" />
          <circle cx="206" cy="184" r="2.2" strokeWidth="1.3" />
          <circle cx="248" cy="190" r="2" strokeWidth="1.3" />

          {/* Gestrichelte Cluster-Kontur & Vektorpfeil im Embedding-Raum */}
          <ellipse cx="122" cy="82" rx="64" ry="38" strokeWidth="0.9" strokeDasharray="6 4" transform="rotate(-12 122 82)" />
          <line x1="22" y1="188" x2="118" y2="98" strokeWidth="1.15" />
          <path d="M109 100 L118 98 L115 107" strokeWidth="1.15" />
          <line x1="22" y1="188" x2="204" y2="184" strokeWidth="0.7" strokeDasharray="4 4" />
          <path d="M62 187 A42 42 0 0 0 50 161" strokeWidth="0.75" />
        </g>

        {/* 7. Kompakte Automatisierungs-Skizze / Regelkreis (Unten rechts, auch mobil sichtbar) */}
        <g transform="translate(1285, 735)">
          <line x1="12" y1="112" x2="262" y2="112" strokeWidth="0.55" strokeDasharray="7 4 2 4" />
          {/* Eingangs-Knoten */}
          <circle cx="48" cy="112" r="15" strokeWidth="1.6" />
          <ellipse cx="48" cy="112" rx="16" ry="14" strokeWidth="0.75" />
          {/* Pfeil zum Entscheidungsblock */}
          <line x1="64" y1="112" x2="108" y2="112" strokeWidth="1.3" />
          <path d="M101 108 L108 112 L101 116" strokeWidth="1.2" />
          {/* Raute / Classifier-Weiche mit Überschwüngen */}
          <path d="M106 112 L142 82 L178 112 L142 142 Z" strokeWidth="1.6" />
          <path d="M103 114 L144 79 M140 144 L181 110" strokeWidth="0.75" />
          {/* Zwei Ausgangspfade */}
          <path d="M178 112 L212 82 L242 82" strokeWidth="1.25" />
          <path d="M235 78 L242 82 L235 86" strokeWidth="1.15" />
          <path d="M178 112 L212 142 L242 142" strokeWidth="1.1" strokeDasharray="4 3" />
          <path d="M235 138 L242 142 L235 146" strokeWidth="1.1" />
          {/* Maßlinie unten */}
          <line x1="48" y1="154" x2="48" y2="182" strokeWidth="0.6" />
          <line x1="242" y1="154" x2="242" y2="182" strokeWidth="0.6" />
          <line x1="42" y1="174" x2="248" y2="174" strokeWidth="0.75" />
          <path d="M55 171 L48 174 L55 177 M235 171 L242 174 L235 177" strokeWidth="0.85" />
        </g>
      </svg>
    </div>
  );
}
