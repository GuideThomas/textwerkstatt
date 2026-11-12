// Kopie aus dem Repo mail-agent, Datei packages/llm/src/first-names.ts, Stand-Commit 5777c8d (10.11.2026), unverändert
// bis auf diese zwei Kopfzeilen. Herkunft und Abweichungen des Moduls: ./pseudonymize.ts (Plan PLAN-textwerkstatt.md §4 Phase 3).
// Häufige Vornamen für die Pseudonymisierung (Plan pseudonymisierung-kosten): „Vorname + großes Wort“ gilt als Person, ganz ohne
// Nachnamenliste. Eigene Zusammenstellung, klein geschrieben, Schwerpunkt Österreich, Deutschland, Schweiz und ihre Nachbarn.
//
// Bewusst nicht dabei sind Namen, die am Satzanfang oder in Überschriften auch etwas anderes sind: August, Juli, Juni, Mai, April,
// Art, Wolf, Rosa, Viola, Luna, Nur, Per, Can, Will, May, Matt, Bill, Grant, Hope, Joy, Summer, Claude. Eine Lücke hier heißt nur,
// dass der Name so stehen bleibt, wie er ohne diese Regel stünde.

const NAMES = `
adalbert adam adolf adrian albert albin albrecht alexander alfons alfred alois aloisius alwin ambros andi andreas andre andré
anselm anton armin arnold arthur artur arno attila axel balthasar basti bastian benedikt benjamin bernd bernhard berthold bertram
björn bodo bruno burkhard carl carsten christian christof christoph christopher clemens conrad cornelius daniel david dennis detlef
dieter dietmar dietrich dirk dominic dominik edgar edmund eduard egon ekkehard elias emanuel emil engelbert erhard erich eric erik
ernst erwin eugen ewald fabian felix ferdinand filip flo florian frank franz fred frederik friedrich fritz gabriel gebhard georg
gerald gerd gerhard gernot gert gottfried gregor guido gunter gunther günter günther gustav hannes hans hansi hansjörg hanspeter
harald harry hartmut heiko heiner heinrich heinz helge helmut helmuth hendrik henning henrik herbert hermann hubert hugo ignaz ingo
jakob jan jens joachim jochen johann johannes jonas jonathan jörg josef joseph julian julius jürgen justus kai karl karsten kaspar
kevin kilian klaus konrad konstantin kurt lars laurenz leo leon leonard leonhard leopold linus lorenz lothar louis luca lucas ludwig
lukas lutz magnus malte manfred manuel marc marcel marco marcus mario marius mark markus martin mathias matteo matthias max maximilian
michael michi mike mirko moritz nico nicolas niklas niko nikolaus nils norbert oliver oskar oswald otmar otto pascal patrick paul
peter philip philipp pius poldi rafael rainer ralf ralph raimund raphael reinhard reinhold rene rené richard robert robin roland rolf
roman rudi rudolf rüdiger rupert ruprecht sascha sebastian sepp siegfried sigmund simon stefan steffen stephan sven theo theodor thilo
thomas thorsten tilo tim timo tobi tobias tom toni torsten ulrich uwe valentin viktor vincent volker waldemar walter walther werner
wilfried wilhelm willi willy winfried wolfgang xaver yannick

adelheid adriana agathe agnes alexandra alice alina aline amalia amelie andrea angela angelika anita anja anke anna annabell annalena
anne annemarie annette annika antje antonia ariane astrid barbara beate beatrice beatrix bettina bianca birgit birgitta brigitte britta
carina carla carmen carola carolin caroline cathrin charlotte christa christel christiane christina christine clara claudia constanze
cordula corinna cornelia dagmar dana daniela diana doris dorothea edith elena elfriede elisa elisabeth elke ella ellen elsa elvira
emilia emma erika erna eva evelyn fabienne felicitas franziska frauke frieda friederike gabi gabriela gabriele gerda gerti gertrud
gisela greta gudrun hanna hannah hannelore hedwig heidi heike helen helena helene helga henriette herta hertha hildegard ida ilona ilse
ina ines inga inge ingeborg ingrid irene iris irmgard isabel isabella isabelle jana janina jasmin jennifer jessica johanna josefine
judith julia juliane jutta karin karina karla katharina kathrin katja katrin kerstin kim klara kristin kristina lara larissa laura lea
lena leonie liane lilli lina linda lisa lisi lotte luisa luise magdalena maike maja mandy manu manuela mara marcella margarete margit
margot maria mariam marianne marie marina marion marlene marlies martha martina mathilde maya melanie melissa mia michaela miriam mona
monika nadine nadja natalie natascha nicola nicole nina nora olga ottilie pamela patricia paula pauline petra pia ramona rebecca regina
renate resi rita romana ronja rosemarie ruth sabina sabine sabrina sandra sara sarah saskia silke silvia simone sonja sophia sophie
stefanie steffi stella stephanie susanne susi svenja sylvia tamara tanja tatjana teresa theresa theresia tina ulla ulrike ursula ute
valentina vanessa vera verena veronika viktoria waltraud wiebke yvonne

alessandro alessia angelo antonio carlo chiara cristina davide domenico emilio enrico enzo fabio federico francesca francesco giacomo
gianluca gianni giorgio giovanni giulia giuliano giuseppe lorenzo luigi massimo mauro michele paolo pietro riccardo roberto salvatore
sergio silvio stefano tiziano umberto vincenzo alejandro alberto alvaro ana carlos diego eduardo enrique fernando francisco gonzalo
guillermo ignacio javier jesus jesús jorge jose josé juan julio lucia luis miguel pablo pedro ramon ramón raul raúl ricardo rodrigo
santiago sofia antoine benoit benoît bernard camille claire clement clément denis didier etienne étienne francois françois gerard
gérard guillaume henri jacques jean julien laurent luc mathieu michel olivier philippe pierre remy rémy sebastien sébastien thierry yves

aaron alan alex allison amanda amy andrew anthony ashley ben betty brandon brenda brian carol catherine charles chris cynthia dave
deborah debra donald donna dorothy douglas edward elizabeth emily ethan frances gary george gerry greg gregory harold heather henry
howard ian jacob james jason jeff jeffrey jeremy jerry jim joan joe john joshua joyce julie justin karen katherine kathleen kelly ken
kenneth kimberly larry lawrence louise margaret mary matthew megan michelle nancy nathan nicholas nick olivia phil rachel raymond rob
ronald russell ryan sam samantha samuel scott sean sharon shirley stephen steve steven susan timothy tony tyler wayne william zachary

anders bjorn finn gunnar johan kristian mats olaf ole thor ulf freya sigrid solveig bram daan joost jeroen maarten pieter ruud sander
wim willem

agnieszka aleksander andrzej bartosz dariusz ewa grzegorz jacek jakub janusz joanna jiri jiří karel katarzyna krzysztof lukasz łukasz
maciej malgorzata małgorzata marek michal michał miroslav ondrej ondřej pavel pawel paweł petr piotr radek rafal rafał stanislav tomasz
tomas tomáš vaclav václav wojciech zbigniew zuzana lenka andras andrás balazs balázs bence csaba gabor gábor istvan istván janos jános
laszlo lászló sandor sándor szabolcs tamas tamás zoltan zoltán zsolt erzsebet erzsébet katalin

aleksandar aleksandra amir ante boris bojan branko dragan dejan darko davor goran haris ivan ivana ivica jelena josip kemal marija marko
mateja mehmed milan milos miloš milena mirjana mladen nedim nenad nikola predrag sanja sasa saša slavko slobodan snezana snežana srdjan
stjepan tomislav vladimir vesna zdravko zoran zeljko željko alexei alexej alexey anastasia andrej andrei dimitri dmitri dmitry galina
igor irina jewgeni juri maxim mikhail natalia natalja nikolai oksana oleg sergei sergej svetlana tatiana vadim yuri

abdullah ahmad ahmed ahmet ali alper arda ayse ayşe aylin aysel baris barış berk burak cem cemal deniz derya dilan ebru elif emin emine
emre esra fatih fatma ferhat gül gülsen hakan hamza hasan hatice hussein huseyin hüseyin ibrahim ismail kerem leyla mahmoud mahmut mehmet
melike merve mohamed mohammad mohammed muhammad murat mustafa omar ömer osman ozan özlem selim selin serkan sinan tarek tolga tuncay umut
yasemin yasin yusuf zeynep akira anh hiroshi kenji linh minh ming wei yuki amit anil deepak priya raj rajesh ravi sanjay sunil vijay
`;

export const FIRST_NAMES: ReadonlySet<string> = new Set(NAMES.split(/\s+/).filter(Boolean));
