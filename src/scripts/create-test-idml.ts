/**
 * Erstellt eine synthetische Test-IDML-Datei für Parser-Tests.
 * IDML = ZIP mit designmap.xml + Stories/*.xml + Spreads/*.xml
 *
 * Aufruf: npx tsx src/scripts/create-test-idml.ts
 */

import AdmZip from 'adm-zip';
import path from 'path';

const outputPath = path.resolve(__dirname, '../../test-data/test.idml');

const zip = new AdmZip();

// mimetype
zip.addFile('mimetype', Buffer.from('application/vnd.adobe.indesign-idml-package'));

// designmap.xml
zip.addFile('designmap.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="16.0" Self="d">
  <idPkg:Story src="Stories/Story_u1a3.xml"/>
  <idPkg:Story src="Stories/Story_u2b4.xml"/>
  <idPkg:Spread src="Spreads/Spread_u100.xml"/>
</Document>
`));

// Story 1: Einfache Absätze (Produkt-Texte)
zip.addFile('Stories/Story_u1a3.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="16.0">
  <Story Self="u1a3" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Headline">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold">
        <Content>LED Streifen</Content>
      </CharacterStyleRange>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content> CRI&gt;90 in warmweiss</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content>Unser hocheffizientes Aluminium-Profil mit integriertem Kuehlkoerper für optimale Waermeableitung.</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content>Ausführung in matt weiß, RAL 9010, Länge 2000mm</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</idPkg:Story>
`));

// Story 2: Kurze Marketing-Texte
zip.addFile('Stories/Story_u2b4.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="16.0">
  <Story Self="u2b4" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Subline">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Italic">
        <Content>Premium Qualitaet</Content>
      </CharacterStyleRange>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content> seit 2007</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content>Farbtemperatur: 3000K (warmweiß)</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</idPkg:Story>
`));

// Spread mit TextFrames
zip.addFile('Spreads/Spread_u100.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="16.0">
  <Spread Self="u100" FlattenerOverride="Default">
    <TextFrame Self="tf1" ParentStory="u1a3" ContentType="TextType">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="false">
            <PathPointArray>
              <PathPointType Anchor="-200 -100" LeftDirection="-200 -100" RightDirection="-200 -100"/>
              <PathPointType Anchor="200 -100" LeftDirection="200 -100" RightDirection="200 -100"/>
              <PathPointType Anchor="200 100" LeftDirection="200 100" RightDirection="200 100"/>
              <PathPointType Anchor="-200 100" LeftDirection="-200 100" RightDirection="-200 100"/>
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
    </TextFrame>
    <TextFrame Self="tf2" ParentStory="u2b4" ContentType="TextType">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="false">
            <PathPointArray>
              <PathPointType Anchor="-150 -30" LeftDirection="-150 -30" RightDirection="-150 -30"/>
              <PathPointType Anchor="150 -30" LeftDirection="150 -30" RightDirection="150 -30"/>
              <PathPointType Anchor="150 30" LeftDirection="150 30" RightDirection="150 30"/>
              <PathPointType Anchor="-150 30" LeftDirection="-150 30" RightDirection="-150 30"/>
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
    </TextFrame>
  </Spread>
</idPkg:Spread>
`));

// META-INF/container.xml (Standard IDML)
zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<container>
  <rootfiles>
    <rootfile full-path="designmap.xml"/>
  </rootfiles>
</container>
`));

// Resources-Platzhalter
zip.addFile('Resources/Fonts.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<idPkg:Fonts xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="16.0"/>\n`));

const fs = require('fs');
const dir = path.dirname(outputPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

zip.writeZip(outputPath);
console.log(`Test IDML created: ${outputPath}`);
