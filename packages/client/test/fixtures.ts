// A mock of the Auswärtiges Amt travel-warning API over its own paths, from answers recorded live
// on 2026-11-19 and cut down: 28 of the list's 200 countries (ids, names, codes, flags and
// times as sent), among them the names the trip-check skill warns about (two Kongos, two Koreas,
// four Guineas, Sudan and Südsudan, USA, the Palestinian territories, Côte d'Ivoire); the advisories
// of Thailand (regional warning), Türkei (no flag, advice against travel in the text) and Mali (full
// warning), their Aktuelles and Sicherheit sections and the first paragraph on health. Every other
// country answers a short advisory without any advice (Österreich: advice only).

import type { HttpRequest, HttpResponse } from "../src/http.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";

/** A country of the list, as the list endpoint sends it. */
export interface ListFixture {
  lastModified: number;
  effective: number;
  title: string;
  countryCode: string;
  iso3CountryCode: string;
  countryName: string;
  warning: boolean;
  partialWarning: boolean;
  situationWarning: boolean;
  situationPartWarning: boolean;
}

/** The list endpoint's own lastModified (a stale dataset-level value, the watch skill says). */
export const LIST_LAST_MODIFIED = 1787576330;

/** The recorded countries by content id. */
export const COUNTRIES: Readonly<Record<string, ListFixture>> = {
  "199124": {
    "lastModified": 1794991261,
    "effective": 1794990600,
    "title": "Polen: Reise- und Sicherheitshinweise",
    "countryCode": "PL",
    "iso3CountryCode": "POL",
    "countryName": "Polen",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "201382": {
    "lastModified": 1793365541,
    "effective": 1793365200,
    "title": "USA/Vereinigte Staaten: Reise- und Sicherheitshinweise",
    "countryCode": "US",
    "iso3CountryCode": "USA",
    "countryName": "USA",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "201536": {
    "lastModified": 1792572319,
    "effective": 1792571400,
    "title": "Russische Föderation: Reise- und Sicherheitshinweise",
    "countryCode": "RU",
    "iso3CountryCode": "RUS",
    "countryName": "Russische Föderation",
    "warning": true,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "201558": {
    "lastModified": 1793007307,
    "effective": 1793007000,
    "title": "Thailand: Reise- und Sicherheitshinweise",
    "countryCode": "TH",
    "iso3CountryCode": "THA",
    "countryName": "Thailand",
    "warning": false,
    "partialWarning": true,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "201904": {
    "lastModified": 1791882652,
    "effective": 1781873100,
    "title": "Belarus: Reise- und Sicherheitshinweise",
    "countryCode": "BY",
    "iso3CountryCode": "BLR",
    "countryName": "Belarus",
    "warning": true,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "201962": {
    "lastModified": 1793971529,
    "effective": 1793970900,
    "title": "Türkei: Reise- und Sicherheitshinweise",
    "countryCode": "TR",
    "iso3CountryCode": "TUR",
    "countryName": "Türkei",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "203202": {
    "lastModified": 1792154266,
    "effective": 1792153800,
    "title": "Demokratische Republik Kongo: Reise- und Sicherheitshinweise",
    "countryCode": "CD",
    "iso3CountryCode": "COD",
    "countryName": "Demokratische Republik Kongo",
    "warning": false,
    "partialWarning": true,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "203266": {
    "lastModified": 1791886088,
    "effective": 1787650200,
    "title": "Sudan: Reise- und Sicherheitshinweise",
    "countryCode": "SD",
    "iso3CountryCode": "SDN",
    "countryName": "Sudan",
    "warning": true,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "203674": {
    "lastModified": 1793283335,
    "effective": 1793282400,
    "title": "Palästinensische Gebiete: Reise- und Sicherheitshinweise",
    "countryCode": "PS",
    "iso3CountryCode": "PSE",
    "countryName": "Palästinensische Gebiete*",
    "warning": true,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "203814": {
    "lastModified": 1793283304,
    "effective": 1793284200,
    "title": "Israel: Reise- und Sicherheitshinweise (Palästinensische Gebiete - Gazastreifen)",
    "countryCode": "IL",
    "iso3CountryCode": "ISR",
    "countryName": "Israel",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "204692": {
    "lastModified": 1791882462,
    "effective": 1787149800,
    "title": "Afghanistan: Reise- und Sicherheitshinweise",
    "countryCode": "AF",
    "iso3CountryCode": "AFG",
    "countryName": "Afghanistan",
    "warning": true,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "206098": {
    "lastModified": 1791886919,
    "effective": 1789387200,
    "title": "Guinea: Reise- und Sicherheitshinweise",
    "countryCode": "GN",
    "iso3CountryCode": "GIN",
    "countryName": "Guinea",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "206408": {
    "lastModified": 1791881484,
    "effective": 1783084500,
    "title": "Vereinigtes Königreich: Reise- und Sicherheitshinweise",
    "countryCode": "GB",
    "iso3CountryCode": "GBR",
    "countryName": "Vereinigtes Königreich",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "208058": {
    "lastModified": 1795101313,
    "effective": 1795100400,
    "title": "Kenia: Reise- und Sicherheitshinweise",
    "countryCode": "KE",
    "iso3CountryCode": "KEN",
    "countryName": "Kenia",
    "warning": false,
    "partialWarning": true,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "208258": {
    "lastModified": 1791885127,
    "effective": 1789387200,
    "title": "Mali: Reise- und Sicherheitshinweise",
    "countryCode": "ML",
    "iso3CountryCode": "MLI",
    "countryName": "Mali",
    "warning": true,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "208542": {
    "lastModified": 1792660031,
    "effective": 1792656000,
    "title": "Republik Kongo: Reise- und Sicherheitshinweise",
    "countryCode": "CG",
    "iso3CountryCode": "COG",
    "countryName": "Republik Kongo",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "209460": {
    "lastModified": 1791883118,
    "effective": 1764601200,
    "title": "Côte d'Ivoire: Reise- und Sicherheitshinweise",
    "countryCode": "CI",
    "iso3CountryCode": "CIV",
    "countryName": "Côte d'Ivoire",
    "warning": false,
    "partialWarning": true,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "210962": {
    "lastModified": 1791881733,
    "effective": 1787842800,
    "title": "Österreich: Reise- und Sicherheitshinweise",
    "countryCode": "AT",
    "iso3CountryCode": "AUT",
    "countryName": "Österreich",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "211084": {
    "lastModified": 1791881707,
    "effective": 1789128000,
    "title": "Königreich der Niederlande: Reise- und Sicherheitshinweise",
    "countryCode": "NL",
    "iso3CountryCode": "NLD",
    "countryName": "Niederlande",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "212622": {
    "lastModified": 1794214888,
    "effective": 1794213900,
    "title": "Ägypten: Reise- und Sicherheitshinweise",
    "countryCode": "EG",
    "iso3CountryCode": "EGY",
    "countryName": "Ägypten",
    "warning": false,
    "partialWarning": true,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "213648": {
    "lastModified": 1792397472,
    "effective": 1792396800,
    "title": "Mexiko: Reise- und Sicherheitshinweise",
    "countryCode": "MX",
    "iso3CountryCode": "MEX",
    "countryName": "Mexiko",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "216104": {
    "lastModified": 1791883100,
    "effective": 1701734400,
    "title": "Demokratische Volksrepublik Korea (Nordkorea): Reise- und Sicherheitshinweise",
    "countryCode": "KP",
    "iso3CountryCode": "PRK",
    "countryName": "Demokratische Volksrepublik Korea (Nordkorea)",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "216132": {
    "lastModified": 1793783152,
    "effective": 1793782800,
    "title": "Republik Korea (Südkorea): Reise- und Sicherheitshinweise",
    "countryCode": "KR",
    "iso3CountryCode": "KOR",
    "countryName": "Republik Korea (Südkorea)",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "218008": {
    "lastModified": 1793283466,
    "effective": 1793282400,
    "title": "Jordanien: Reise- und Sicherheitshinweise",
    "countryCode": "JO",
    "iso3CountryCode": "JOR",
    "countryName": "Jordanien",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "220332": {
    "lastModified": 1792662062,
    "effective": 1792661400,
    "title": "Guinea-Bissau: Reise- und Sicherheitshinweise",
    "countryCode": "GW",
    "iso3CountryCode": "GNB",
    "countryName": "Guinea-Bissau",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "220698": {
    "lastModified": 1791983919,
    "effective": 1791982800,
    "title": "Papua-Neuguinea: Reise- und Sicherheitshinweise",
    "countryCode": "PG",
    "iso3CountryCode": "PNG",
    "countryName": "Papua-Neuguinea",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "226768": {
    "lastModified": 1791882435,
    "effective": 1757063700,
    "title": "Äquatorialguinea: Reise- und Sicherheitshinweise",
    "countryCode": "GQ",
    "iso3CountryCode": "GNQ",
    "countryName": "Äquatorialguinea",
    "warning": false,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  },
  "244250": {
    "lastModified": 1791886139,
    "effective": 1789387200,
    "title": "Südsudan: Reise- und Sicherheitshinweise",
    "countryCode": "SS",
    "iso3CountryCode": "SSD",
    "countryName": "Südsudan",
    "warning": true,
    "partialWarning": false,
    "situationWarning": false,
    "situationPartWarning": false
  }
};

/** The recorded advisories: lastChanges and content (cut down). */
export const ADVISORIES: Readonly<Record<string, { lastChanges: string; content: string }>> = {
  "201558": {
    "lastChanges": "Letzte Änderungen: <br><span>Reiseinfos – Infrastruktur/Verkehr</span><br><span>Einreise und Zoll - Anmerkungen</span><br><span>Redaktionelle Änderungen</span>",
    "content": "<h2>Aktuelles</h2><p><strong>Vor Reisen in das Grenzgebiet (20 km zum Grenzverlauf) zu Kambodscha wird gewarnt.</strong></p><p><span><strong>Von Reisen in die Provinzen Narathiwat, Yala und Pattani sowie Teile von Songkhla (Bezirke Chana, Na Thawi, Thepha und Saba Yoi) im Süden Thailands wird dringend abgeraten.</strong></span></p><h3>Reduzierung der visumsfreien Aufenthaltsdauer</h3><p>Bei visumsfreien Einreisen für touristische Aufenthalte wird von den zuständigen thailändischen Behörden seit dem 15. September 2026 eine Aufenthaltsdauer von maximal 30 Tagen gewährt, siehe <em>Einreise und Zoll</em>.</p><h3>Sicherheitslage im Grenzgebiet zu Kambodscha</h3><p>Im Grenzgebiet zwischen Thailand und Kambodscha kam es seit Juli 2025 zu militärischen Auseinandersetzungen mit Toten und Verletzten. Ende Dezember 2025 wurde ein Waffenstillstand vereinbart.</p><p><span>Die Sicherheitslage in der Grenzregion bleibt jedoch angespannt und unübersichtlich. Es kann jederzeit zu einer erneuten Eskalation oder Lageänderung kommen. Sämtliche Grenzübergänge zwischen Thailand und Kambodscha sind weiterhin geschlossen. In der unmittelbaren Grenzregion können unter anderem nicht geräumte Kampfmittel und Minenfelder eine zusätzliche Gefahr darstellen.</span></p><ul class=\"rte--list\"><li><strong>Beachten Sie die geltende Teilreisewarnung.</strong></li><li><span>Informieren Sie sich in den lokalen und internationalen Medien über die aktuelle Lage.</span></li><li><span>Meiden Sie Demonstrationen und größere Menschenansammlungen weiträumig.</span></li><li><span>Folgen Sie den Anweisungen der Sicherheitskräfte.</span></li><li><span><span class=\"underline\">Registrieren Sie sich</span> und Ihre mitreisenden Familienangehörigen in der </span><a href=\"https://krisenvorsorgeliste.diplo.de/signin\"><span>Krisenvorsorgeliste</span></a><span> des Auswärtigen Amts bzw. <span class=\"underline\">prüfen Sie, ob Ihre dort hinterlegten Daten</span> </span>aktuell sind.</li><li><span>Machen Sie auch andere deutsche Staatsangehörige auf die Möglichkeit der Registrierung aufmerksam!</span></li></ul><h2>Sicherheit - <span>Teilreisewarnung</span></h2><p><strong>Vor Reisen in das Grenzgebiet (20 km zum Grenzverlauf) zu Kambodscha wird gewarnt.</strong></p><p><span><strong>Von Reisen in die Provinzen Narathiwat, Yala und Pattani sowie Teile von Songkhla (Bezirke Chana, Na Thawi, Thepha und Saba Yoi) im Süden Thailands wird dringend abgeraten.</strong></span></p><h3>Terrorismus</h3><p>Die weltweite Gefahr terroristischer Anschläge und Entführungen besteht unverändert fort. Auch in Thailand können Anschläge selbst in Urlaubsgebieten nicht ausgeschlossen werden; dort kann es zu Sicherheitskontrollen und der Einrichtungen von Straßen-Check-Points kommen.</p><p><span>In den Provinzen Narathiwat, Yala und Pattani sowie Teilen von Songkhla (Bezirke Chana, Na Thawi, Thepha und Saba Yoi) im Süden Thailands an der Grenze zu Malaysia kommt es regelmäßig zu Auseinandersetzungen zwischen Separatistengruppen und Sicherheitskräften sowie zu terroristischen Anschlägen, auch auf von Ausländern frequentierte Ziele. Dort gelten Notstandsgesetze. In einzelnen Distrikten, insbesondere an der Grenze zu Malaysia, kann es auch kurzfristig zur Verhängung nächtlicher Ausgangssperren kommen.</span></p><ul class=\"rte--list\"><li>Seien Sie an von Touristen frequentierten und belebten Orten und bei besonderen Anlässen und Großveranstaltungen, wie z. B. \"Mondscheinpartys\", besonders aufmerksam.</li><li>Folgen Sie stets den Anweisungen von Sicherheitskräften, bei unvermeidbaren Aufenthalten in den Südprovinzen auch im Fall nächtlicher Ausgangssperren. </li><li>Beachten Sie den <a href=\"https://www.auswaertiges-amt.de/de/reiseundsicherheit/weltweiter-sicherheitshinweis-1796970\" target=\"_self\" title=\"Weltweiter Sicherheitshinweis\">weltweiten Sicherheitshinweis.</a></li></ul><h3>Innenpolitische Lage</h3><p>Siehe <em>Aktuelles</em></p><p><span>Es kann in allen Landesteilen zu Demonstrationen und anderen Kundgebungen kommen. Gewaltsame Zusammenstöße zwischen Demonstranten und Sicherheitskräften sind nicht auszuschließen. In den Provinzen Narathiwat, Yala und Pattani sowie Teilen von Songkhla im Süden Thailands an der Grenze zu Malaysia kann es zu Auseinandersetzungen und Anschlägen kommen. Hier gilt das Notstandsrecht. </span><br/><span>Die Meinungsfreiheit ist eingeschränkt. Kritik am König und dem thailändischen Königshaus kann als Majestätsbeleidigung strafrechtlich verfolgt werden, insbesondere, wenn sie unter Nutzung elektronischer Medien geäußert wird. </span></p><ul class=\"rte--list\"><li>Seien Sie sich des strengen Majestätsbeleidigungsgesetzes in Thailand bewusst, <em>siehe Reiseinfos - Rechtliche Besonderheiten</em>.</li><li>Informieren Sie sich über die lokalen und internationalen Medien.</li><li>Meiden Sie Demonstrationen und größere Menschenansammlungen weiträumig.</li><li>Folgen Sie den Anweisungen der Sicherheitskräfte.</li></ul><h3>Kriminalität</h3><p>Thailand verzeichnet zunehmende Kriminalität. Neben Diebstahl und Betrugsfällen kommen auch Gewaltverbrechen wie Vergewaltigung und Raubüberfälle, auch mittels mit Betäubungsmitteln versetzter Getränke in Bars und Clubs, teilweise mit Todesfolge, vor. Das betrifft insbesondere die Tourismushochburgen Phuket, Koh Samui, Koh Tao und Pattaya. Auf den monatlich stattfindenden \"Mondscheinpartys\" (Full Moon Party) auf der nördlich von Koh Samui gelegenen Insel (Koh) Pha Ngan ist es bereits mehrfach zu tödlichen Zwischenfällen sowie zur Vergewaltigung von unter Drogen oder Alkohol stehenden Touristinnen gekommen.</p><p>Frauen wird empfohlen, ihrer persönlichen Sicherheit besondere Aufmerksamkeit zu schenken und einsame Gegenden sowie unbeleuchtete Straßen nach Einbruch der Dunkelheit zu meiden.</p><p>In vielen Touristenhochburgen ist die Zusammenarbeit von Banden mit korrupten Polizeibeamten keine Seltenheit. Dabei wird Touristen unterstellt, gemietete Gegenstände wie Jet Skis oder Motorroller beschädigt zurückgegeben oder Bagatelldelikte, wie z. B. einen Diebstahl von Uhrenimitaten, begangen zu haben, um Geld zu erpressen. Besonders auffällig geworden ist die Polizeistation am Patong Beach.</p><p>Die Gefahr von Betrugsversuchen unter Mitwirkung von Taxi- und Tuk-Tuk-Fahrern ist hoch. Touristen werden z.B. gezielt in Geschäfte geführt und unter Druck gesetzt, dort Fälschungen oder minderwertige Produkte zu kaufen.</p><p>In entlegenen Gebieten und in den Grenzgebieten zu Kambodscha und Myanmar kann es zu Überfällen durch bewaffnete Banden kommen. Sicherheitsvorkehrungen in Hotels und Clubs in Thailand entsprechen teilweise nicht europäischen Standards.</p><p>Seit einiger Zeit werden Ausländer mit Angeboten vorgeblich lukrativer Arbeit nach Thailand gelockt und anschließend illegal in die Nachbarländer Myanmar, Laos und Kambodscha geschleust. Dort werden sie zu Dienstleistungen auf dem Gebiet des Computer- und Telefonbetrugs in sog. „Scam Compounds\" gezwungen, festgehalten und in vielen Fällen misshandelt. In der Grenzregion „Goldenes Dreieck“, an der Grenze zu Myanmar und Laos, kommt es zu erheblichen kriminellen Aktivitäten in den Bereichen Drogen- und Menschenhandel sowie Arbeitsbetrug.</p><ul class=\"rte--list\"><li>Nehmen Sie in Bars von Unbekannten keine Getränke an und lassen Sie Ihre Drinks nicht unbeaufsichtigt.</li><li>Achten Sie besonders als Frau auf Ihre persönliche Sicherheit, meiden Sie einsame Gegenden ebenso wie unbeleuchtete Straßen nach Einbruch der Dunkelheit.</li><li>Benutzen Sie nur Taxis oder Tuk-Tuks, deren Fahrer Sie selbst angesprochen haben.</li><li>Bereiten Sie Trekking-Touren gut vor und unternehmen Sie diese am besten in einer Reisegruppe unter sachkundiger Führung.</li><li>Achten Sie bei Fähren und Ausflugsbooten auf Sicherheits- und Rettungseinrichtungen und seien Sie entsprechend vorsichtig.</li><li>Nehmen Sie in Fällen möglicher Erpressung durch/unter Beteiligung korrupter Polizisten unverzüglich Kontakt mit der <a href=\"https://bangkok.diplo.de/th-de\">deutschen Botschaft in Bangkok</a> auf.</li><li>Geben Sie Ihren Reisepass bei Anmietung von Fahrzeugen nicht als Pfand.</li><li>Prüfen Sie angebliche Arbeitsangebote sorgfältig und seien Sie sich der Gefahr bewusst, dass es sich um kriminelle Unternehmungen handeln könnte.</li><li>Bewahren Sie Geld, Ausweise, Führerschein und andere wichtige Dokumente sicher auf und speichern Sie ggf. elektronische Kopien/Fotos. Dies erleichtert im Falle von Diebstahl oder Verlust die Ausstellung eines Ersatzdokuments.</li><li>Geben Sie bargeldlosen Zahlungen den Vorzug und nehmen Sie nur das für den Tag benötigte Bargeld und keine unnötigen Wertsachen oder auffälligen Schmuck mit.</li><li>Seien Sie in größeren Menschenmengen wie an Flughäfen, Bahnhöfen, in Bussen und an Stränden aufmerksam und achten Sie auf Ihre Wertsachen.</li><li>Seien Sie bei ungewohnten E-Mails, Telefonanrufen, Gewinnmitteilungen, Angeboten und Hilfeersuchen angeblicher Bekannter skeptisch. Teilen Sie keine Daten von sich mit, sondern vergewissern Sie sich ggf. persönlich der Glaubwürdigkeit oder wenden Sie sich an die Polizei.</li></ul><h2>Gesundheit</h2><h3>Impfschutz</h3><h4><em>Pflichtimpfungen</em></h4><p>Für die direkte Einreise aus Deutschland sind keine Impfungen vorgeschrieben. Bei Einreise aus einem Gelbfiebergebiet oder Aufenthalt von mehr als 12 Stunden im Transit eines Gelbfiebergebiets müssen alle Personen ab neun Monaten eine<em><span> </span></em>Gelbfieberimpfung<em><span> </span></em>nachweisen. </p>"
  },
  "201962": {
    "lastChanges": "Letzte Änderungen: <br><span>Aktuelles – Weltklimakonferenz (COP31) in Antalya</span><br><span>Sicherheitslage in der Region</span><br><span>Redaktionelle Änderungen</span>",
    "content": "<h2>Aktuelles</h2><h3><em>Weltklimakonferenz (COP31) in Antalya</em></h3><p>Anlässlich der Weltklimakonferenz (COP31) vom 9. bis 20. November 2026 – und insbesondere im zeitlichen Zusammenhang mit dem am 11./12. November 2026 stattfindenden Gipfeltreffen - ist im Großraum Antalya mit erhöhten Sicherheitsvorkehrungen, zeitweisen Straßensperrungen und Verkehrsbehinderungen zu rechnen. Besonders betroffen sind voraussichtlich die Bereiche Belek und Lara sowie die Verkehrsverbindungen zwischen dem Flughafen Antalya und den Veranstaltungsorten. </p><ul class=\"rte--list\"><li>Beachten Sie die Hinweise und Anweisungen der örtlichen Behörden und Sicherheitskräfte.</li><li>Meiden Sie Demonstrationen und größere Menschenansammlungen.</li><li>Planen Sie insbesondere für Fahrten zum und vom Flughafen zusätzliche Zeit ein.</li></ul><h3><em>LGBTIQ</em></h3><p>Am 12. und 13. September 2026 wurden in fünfzehn türkischen Provinzen (darunter Izmir, Aydin, Ankara, Mersin und Istanbul) Razzien in verschiedenen Lokalitäten, Privatwohnungen sowie Vereinen der türkischen LGBTIQ-Community durchgeführt. Dabei kam es zu über 100 Festnahmen sowie zur Sperrung von Internetseiten und Social-Media-Accounts. In den Folgetagen kam es bei Solidaritäts-Veranstaltungen für die LGBTIQ-Community zu weiteren Festnahmen, siehe <em>Reiseinfos - LGBTIQ</em>.<span> </span></p><ul class=\"rte--list\"><li><span>Informieren Sie sich in den Medien zur jeweils aktuellen Lage, etwaigen Versammlungsverboten und weiteren möglichen Einschränkungen.</span></li><li>Meiden Sie Demonstrationen und größere Menschenansammlungen und seien Sie auch in deren Umfeld äußerst vorsichtig, siehe auch <em>Reiseinfos - Rechtliche Besonderheiten</em>.</li><li><span>Machen Sie sich bewusst, dass in Teilen der türkischen Gesellschaft mit starken Vorurteilen und Ressentiments gegenüber LGBTIQ gerechnet werden muss.</span></li></ul><h3><em>Sicherheitslage in der Region</em></h3><p>Die Sicherheitslage in der Region bleibt äußerst volatil. Die Unsicherheiten in der Region und die Risiken einer plötzlichen Eskalation im Zuge des Iran-Konflikts bestehen fort und wurden zuletzt durch die militärischen Auseinandersetzungen zwischen den Huthis und Saudi-Arabien noch verstärkt. Das Risiko einer erneuten Ausweitung der Kampfhandlungen ist jederzeit und ohne Vorwarnzeiten gegeben. <br/>Auch für Länder, die wie die Türkei nicht unmittelbar am Konflikt im Nahen und Mittleren Osten beteiligt sind, können erneute Kampfhandlungen wie bereits im Frühjahr 2026 jederzeit und ohne Vorwarnzeiten massive Einschränkungen im Flugverkehr (auch für Transitreisende) nach sich ziehen, bis hin zu kompletten Luftraumsperrungen und Flugausfällen. </p><p>In allen Teilen der Türkei muss zudem grundsätzlich von einer terroristischen Gefährdung ausgegangen werden.</p><ul class=\"rte--list\"><li><span>Beachten Sie die Hinweise im Abschnitt Sicherheit/Terrorismus sowie den</span> <a href=\"https://www.auswaertiges-amt.de/de/reiseundsicherheit/weltweiter-sicherheitshinweis-1796970\" target=\"_blank\" rel=\"noopener\" title=\"Weltweiter Sicherheitshinweis\"><strong>weltweiten Sicherheitshinweis.</strong></a></li><li>Befolgen Sie besonders im Fall einer erneuen Verschärfung der Sicherheitslage die Anweisungen der Behörden und Sicherheitskräfte. Seien Sie vor allem an belebten Orten und zu besonderen Anlässen, insbesondere rund um US-amerikanische, jüdische und israelische sowie generell alle militärischen Einrichtungen, äußerst aufmerksam.</li><li>Meiden Sie größere Menschenansammlungen auch auf öffentlichen Plätzen und vor touristischen Attraktionen sowie den Aufenthalt in der Nähe von Regierungs- und Militäreinrichtungen.</li><li>Meiden Sie abgelegene Gegenden und wenig befahrene Landstraßen.</li><li>Laden Sie Mobiltelefone sowie andere Kommunikationsmittel und externe Batterien immer voll auf.</li><li><span>Generell wird allen Reisenden weltweit empfohlen, sich auf die </span><a href=\"https://krisenvorsorgeliste.diplo.de/signin\"><span>Krisenvorsorgeliste</span></a><span> des Auswärtigen Amts einzutragen und die dort hinterlegten Daten regelmäßig zu aktualisieren.</span></li></ul><h3><em>Demonstrationen</em></h3><p>Seit mehreren Monaten kommt es in größeren Städten vermehrt zu Demonstrationen, in deren Verlauf in Istanbul wichtige Metrostationen im Stadtzentrum gesperrt wurden. </p><ul class=\"rte--list\"><li><span>Informieren Sie sich in den Medien zur jeweils aktuellen Lage, etwaigen Versammlungsverboten und möglichen Einschränkungen.</span></li><li><span>Meiden Sie Demonstrationen und größere Menschenansammlungen und seien Sie in deren Umfeld äußerst vorsichtig, siehe auch </span><em><span>Rechtliche Besonderheiten.</span></em><span> </span></li></ul><h3><em>Festnahmen und Einreiseverweigerungen</em></h3><p><span>Es gibt weiterhin Fälle, in denen deutsche Staatsangehörige willkürlich festgenommen, mit einer Ausreisesperre belegt oder an der Einreise in die Türkei gehindert werden. Auch Personen, die in der Vergangenheit ohne Probleme ein- und ausreisen konnten, können bei einem erneuten Aufenthalt aufgrund zeitlich weit zurückliegender oder neuer Tatvorwürfe festgenommen werden. Den Strafverfolgungsmaßnahmen </span>liegt in vielen Fällen der Verdacht der Propaganda für, die Unterstützung von oder die Mitgliedschaft in einer in der Türkei als terroristisch eingestuften Organisation zugrunde, z. B. der PKK oder „Gülen-Bewegung“, siehe <em>Rechtliche Besonderheiten</em>. </p><p><span>Die türkischen Strafverfolgungsbehörden führen offenbar umfangreiche Listen von Personen mit Wohnsitz in Deutschland, die auch ohne hinreichende Vorermittlungen zum Ziel von Strafverfolgungsmaßnahmen werden können.</span></p><p>Aufgrund des weit gefassten Terrorismusbegriffs in der Türkei, der aus Sicht des Europäischen Gerichtshofs für Menschenrechte rechtsstaatswidrig ist, können z. B. bloße Äußerungen, das Teilen, Kommentieren oder „Liken“ von Beiträgen in sozialen Medien, die in Deutschland vom Grundrecht der freien Meinungsäußerung gedeckt sind, für eine Strafverfolgung ausreichen. Gemäß dem türkischen „Anti-Desinformationsgesetz“ kann die Verbreitung von Aussagen, die von Strafverfolgungsbehörden als unwahr und als Gefährdung für die Sicherheit des Landes, die öffentliche Ordnung oder die Gesundheit der Bevölkerung eingestuft werden, ebenfalls zu Strafverfolgung führen. Auch die Teilnahme an Demonstrationen in Deutschland, die Unterzeichnung von <span>Petitionen an die Bundesregierung (z.B. Petition „Initiative für ein unabhängiges Kurdistan“ von 2014) </span>oder die Mitgliedschaft in einem in Deutschland legal eingetragenen Verein mit Bezug zu kurdischen Anliegen kann Anlass für Festnahmen, Ausreisesperren oder Einreiseverweigerungen sein, auch wenn die entsprechenden Betätigungen teils jahrelang zurückliegen.<span> </span></p><p>Festnahmen, Strafverfolgungen oder Ausreisesperren sind auch im Zusammenhang mit regierungskritischen Stellungnahmen in den sozialen Medien zu beobachten, vermehrt auch aufgrund von Vorwürfen der Präsidentenbeleidigung oder terroristischer Aktivitäten.<span> </span>Hierfür wurden bereits mehrjährige Haftstrafen verhängt. Auch Ausreisesperren können für Personen mit Lebensmittelpunkt in Deutschland existenzbedrohende Konsequenzen haben.</p><p>Diese Maßnahmen treffen insbesondere (aber nicht ausschließlich) deutsche Staatsangehörige mit privaten und persönlichen Bindungen in die Türkei sowie Personen, die neben der deutschen auch die türkische Staatsangehörigkeit besitzen<span>. Allerdings können auch ausschließlich deutsche Staatsangehörige betroffen sein.</span></p><p><span>Auch Journalisten wurde die Akkreditierung ohne Angabe von Gründen verweigert. </span>Äußerungen, die nach deutschem Rechtsverständnis von der Meinungsfreiheit gedeckt sind, können in der Türkei zu berufsbeschränkenden Maßnahmen und Strafverfahren führen.</p><ul class=\"rte--list\"><li>Halten Sie sich von politischen Veranstaltungen, Kundgebungen und grundsätzlich von größeren Menschenansammlungen fern.</li><li><span>Seien Sie sich bewusst, dass in Deutschland getätigte Meinungsäußerungen und Handlungen in der Türkei als regierungskritisch wahrgenommen werden könnten und dort deshalb zu strafrechtlichen Konsequenzen führen können. Gleiches gilt für regierungskritische Äußerungen in den sozialen Medien sowie das bloße Teilen oder Liken eines fremden Beitrags. Auch nichtöffentliche Kommentare können durch anonyme Denunziation an türkische Strafverfolgungsbehörden weitergeleitet werden.</span></li><li><span>Beachten Sie, dass auch die konsularische Unterstützung durch die zuständige deutsche Auslandsvertretung Sie nicht vor strafrechtlicher Verfolgung schützen kann.</span></li><li>Beachten Sie die Hinweise unter <em>Innenpolitische Lage</em> und <em>Rechtliche Besonderheiten</em>.</li><li>Beachten Sie auch, insbesondere zu Einreiseverweigerungen, die Hinweise unter <em>Einreise und Zoll</em> zu Einreisekontrolle und Zurückweisungen. </li></ul><h2>Sicherheit</h2><h3>Terrorismus</h3><p>In allen Teilen der Türkei muss grundsätzlich von einer terroristischen Gefährdung ausgegangen werden, insbesondere in den großen Metropolen.</p><p>Die Sicherheitsvorkehrungen befinden sich landesweit auf hohem Niveau, vor allem in großen Städten ist eine erhöhte Präsenz von Polizei und Sicherheitskräften sichtbar. Seit 2015 kam es wiederholt zu Anschlägen terroristischer Gruppierungen auch gegen nicht-militärische Ziele. Auch in den <span>Innenstädten von Istanbul und Ankara gab es bereits Anschläge mit hohen Opferzahlen, wie </span>2022 bei einem Sprengstoffanschlag auf der Istanbuler Einkaufsstraße Istiklal und <span>2023 bei einem Bombenanschlag auf das Innenministerium der Türkei in der Nähe des Parlaments in Ankara. </span>Im Januar 2024 kam es durch zwei Täter zu einem bewaffneten Angriff auf die katholische Kirche Sankt Marien in Sariyer-Istanbul, bei dem eine Person tödlich verletzt wurde. <span>Am 7. April 2026 kam es zu einem bewaffneten Angriff in der Nähe des israelischen Generalkonsulats in Istanbul.</span></p><p><span>Die</span> als terroristische Vereinigung gelistete „Kurdische Arbeiterpartei“ (PKK) sowie ihre Splittergruppe „Freiheitsfalken Kurdistans“ verüben seit 2015 vor allem im <span>Südosten der Türkei, aber auch in anderen Landesteilen </span>immer wieder Anschläge. Weitere Entwicklungen im Rahmen des Ende 2024 angestoßenen Lösungsprozesses (auch „Friedens-Prozess“ oder „Prozess für eine Terror-freie Türkei“) zur Kurdenfrage bleiben abzuwarten. </p><h4><em>Südosten und Osten/Grenzgebiete zu Syrien und Irak</em></h4><p><span>Im unmittelbaren Grenzgebiet der Türkei zu Syrien (Provinzen Şanlıurfa und Mardin) und zu Irak bestehen Gefahren durch angrenzende Auseinandersetzungen. </span></p><ul class=\"rte--list\"><li><span><strong>Beachten Sie die Reisewarnungen für </strong></span><a href=\"https://www.auswaertiges-amt.de/de/service/laender/syrien-node/syriensicherheit-204278\"><span><strong>Syrien,</strong></span></a><span><strong> </strong></span><a href=\"https://www.auswaertiges-amt.de/de/service/laender/iran-node/iransicherheit-202396\"><span><strong>Iran</strong></span></a><span><strong> </strong></span><strong>und</strong> <a href=\"https://www.auswaertiges-amt.de/de/service/laender/irak-node/iraksicherheit-202738\"><span><strong>Irak.</strong></span></a></li><li><span>Seien Sie insbesondere an belebten Orten und bei unvorhergesehenen Ereignissen aufmerksam.</span></li><li>Vermeiden Sie alle nicht zwingend erforderlichen Reisen in die o.g. Grenzgebiete.</li><li>Halten Sie sich zur Sicherheitslage laufend informiert.</li><li><span>Meiden Sie größere Menschenansammlungen auch auf öffentlichen Plätzen und vor touristischen Attraktionen sowie den Aufenthalt in der Nähe von Regierungs- und Militäreinrichtungen.</span></li><li>Meiden Sie abgelegene Gegenden und wenig befahrene Landstraßen.</li><li>Beachten Sie den <a href=\"https://www.auswaertiges-amt.de/de/reiseundsicherheit/weltweiter-sicherheitshinweis-1796970\" target=\"_blank\" rel=\"noopener\" title=\"Weltweiter Sicherheitshinweis\">weltweiten Sicherheitshinweis.</a></li></ul><h3>Innenpolitische Lage</h3><p>Siehe <em>Aktuelles</em></p><p>Es ist weiterhin von einem erhöhten Risiko der Festnahme oder der Verhängung einer Ausreisesperre auszugehen, siehe hierzu die Hinweise unter <em>Aktuelles </em>und <em>Reiseinfos: Rechtliche Besonderheiten</em>.</p><p><span>Aufgrund des andauernden Konflikts in Israel und den Palästinensischen Gebieten kann es in der Türkei zu spontanen, pro-palästinensischen Protestkundgebungen und gewaltsamen Ausschreitungen kommen. Auch anderweitige Proteste und Demonstrationen mit vereinzelten gewaltsamen Auseinandersetzungen und Verkehrsbehinderungen können nicht ausgeschlossen werden.</span></p><ul class=\"rte--list\"><li>Informieren Sie sich über die lokalen Medien.</li><li>Meiden Sie Demonstrationen und größere Menschenansammlungen weiträumig.</li><li>Folgen Sie den Anweisungen lokaler Sicherheitskräfte.</li></ul><h3>Kriminalität</h3><p><span>Die Türkei zeichnet sich bislang als ein Land mit vergleichsweise gering ausgeprägter Gewaltkriminalität aus. </span></p><p><span>Wie auch in anderen Großstädten ist in Istanbul Vorsicht vor Taschendieben angezeigt. Dabei werden die Opfer vielfach von bettelnden Kindern abgelenkt. </span><br/><span>Vor allem im Stadtteil Beyoğlu wurden vermehrt Betrugsfälle bekannt, in denen Touristen unter einem Vorwand in eine Bar eingeladen und anschließend gezwungen wurden, zur Begleichung der extrem überhöhten Rechnung eine größere Summe Bargeld von einem Geldautomaten abzuheben.</span><br/><span>Auch kommt es immer wieder zu Passdiebstählen. </span></p><p><span>Ausländer, insbesondere allein oder in kleinen Gruppen reisende Frauen, sind vereinzelt von gewaltsamen, auch sexuellen Übergriffen betroffen. Auch Minderjährige sind Ziel sexueller Übergriffe geworden, z.B. auf dem Weg zu den Toiletten in Lokalen.</span></p><p><span>Deutsche Urlauber wurden in der Vergangenheit nach ihrer Rückkehr Opfer von Betrugsfällen. So werden Urlauber unter einem erfundenen Vorwand (z.B. Lotteriegewinn, Steuernachzahlung, drohende Vermögensnachteile) telefonisch zu einer Geldüberweisung per internationalem Zahlungsdienstleister in die Türkei veranlasst. Alternativ werden Urlauber (meist per E-Mail) aufgefordert, umgehend eine Zahlung für angebliche Transitgebühren des türkischen Zolls für Paketsendungen zu leisten, da sonst angeblich kein Versand erfolgen kann. Derartige Gebühren werden in der Türkei nicht erhoben.</span></p><p><span>Vor allem im Großraum Istanbul sind vermehrt Fälschungen ausländischer Banknoten aufgetaucht. Teilweise wurden auch gefälschte 50- und 100-USD-Noten in Geldautomaten entdeckt, die eine ungewöhnlich große Nähe zum Original aufweisen.</span> </p><ul class=\"rte--list\"><li>Seien Sie besonders bei einem Aufenthalt an einsamen Orten und gemeinsamen Unternehmungen mit wenig bekannten Personen vorsichtig.</li><li>Lassen Sie sich stets von Vorsicht leiten und praktizieren Sie immer situationsangemessenes und kulturbewusstes Verhalten. Dies trifft insbesondere auf alleinreisende Frauen vor dem Hintergrund der Berichte über sexuelle Übergriffe zu.</li><li>Bewahren Sie Geld, Ausweise, Führerschein und andere wichtige Dokumente sicher auf; speichern Sie ggf. elektronische Kopien/Fotos. Dies erleichtert im Falle von Diebstahl oder Verlust die Ausstellung eines Ersatzdokuments.</li><li><span>Geben Sie bargeldlosen Zahlungen den Vorzug und nehmen Sie nur das für den Tag benötigte Bargeld und keine unnötigen Wertsachen oder auffälligen Schmuck mit Seien Sie in größeren Menschenmengen wie an Flughäfen, Bahnhöfen, in öffentlichen Verkehrsmitteln besonders aufmerksam und achten Sie auf Ihre Wertsachen.</span></li><li>Seien Sie in größeren Menschenmengen wie an Flughäfen, Bahnhöfen, in öffentlichen Verkehrsmitteln besonders aufmerksam und achten Sie auf Ihre Wertsachen.</li><li><span>Kaufen Sie Alkohol nur in lizenzierten Fachgeschäften. Achten Sie auf ungeöffnete Originalverpackungen und offizielle Lizenzierung (Steuerbanderole); schlechte Druckqualität (auf der Banderole) bzw. falsche Schreibweisen können auf Fälschungen hindeuten. Meiden Sie selbstgebrannten bzw. gepanschten Alkohol (Gefahr der Methanolvergiftung, siehe auch </span><em><span>Gesundheit - Aktuelles</span></em><span>). </span></li><li>Seien Sie bei ungewohnten E-Mails, Telefonanrufen, Zahlungsaufforderungen, Gewinnmitteilungen, Einladungen und Hilfeersuchen angeblicher Bekannter oder Anrufen angeblicher Polizei – und Justizbeamten skeptisch. Teilen Sie keine Daten von sich mit, sondern vergewissern Sie sich ggf. persönlich der Glaubwürdigkeit oder wenden Sie sich an die Polizei.</li></ul><h2>Gesundheit</h2><h3>Impfschutz</h3><p>Für die direkte Einreise aus Deutschland sind keine Pflichtimpfungen vorgeschrieben.</p>"
  },
  "208258": {
    "lastChanges": "Letzte Änderungen: <span>Redaktionelle Änderungen</span>",
    "content": "<h2>Aktuelles</h2><p><span><strong>Vor Reisen nach Mali wird gewarnt.</strong></span></p><p><strong>Deutsche Staatsangehörige werden aufgefordert, Mali auf dem Luftweg zu verlassen.</strong></p><p><strong>Vor Ausreisen über Land wird gewarnt, da die Nationalstraßen derzeit Ziele von Angriffen terroristischer Gruppen sind. </strong></p><h3><em>Sicherheitslage in Mali</em></h3><p><span>Am 25. April 2026 fanden koordinierte Angriffe durch die Al-Qaida-nahe, islamistische Terrororganisation Jama’at Nusrat al-Islam wal-Muslimin (JNIM) und die Rebellenorganisation Front de libération de l’Azawad (FLA) in mehreren Landesteilen Malis statt. Diese richteten sich in Bamako gegen das Hauptquartier der malischen Streitkräfte (FAMa) in Kati sowie die Militärbasis am internationalen Flughafen in Senou. Betroffen waren zudem die Städte Kidal, Gao, Bourem, Sévaré und Mopti. Westliche Personen oder Einrichtungen waren nicht Ziel der Angriffe. </span></p><p><span>Am 04. Juli 2026 gab es erneut Angriffe auf militärische Ziele, insb. im Norden des Landes, ebenso in Sévaré und Keniéroba. Die malische Armee konnte die Attacken überwiegend abwehren. Die Sicherheitslage bleibt im gesamten Land volatil; es besteht weiterhin ein erhöhtes Risiko für eine erneute Verschärfung der Sicherheitslage im gesamten Land, einschließlich in Bamako. </span></p><h3><em>Terrorbedrohung</em></h3><p>Die Aktivitäten der Terrororganisation JNIM im Süden Malis haben in den letzten Monaten stark zugenommen. Gezielte Angriffe auf Treibstofftransporte haben seit September 2025 zu zeitweise massiver Treibstoffknappheit in der Hauptstadt Bamako geführt. Das Risiko weiterer Angriffe auf Transporte und erneuter Treibstoffknappheit besteht fort. In Bamako besteht zudem ein erhöhtes Risiko für Terroranschläge. Mögliche Ziele sind in erster Linie Einrichtungen der malischen Sicherheitskräfte und der Regierung, aber auch öffentliche Orte einschließlich des internationalen Flughafens (BKO). JNIM hat angekündigt, auch gegen die Zivilbevölkerung vorzugehen, wenn diese sich der Terrororganisation entgegenstellt. </p><p><span>Sowohl in der Hauptstadt sowie in den übrigen Landesteilen Malis wird zu besonderer Vorsicht geraten.</span></p><ul class=\"rte--list\"><li><span>Beachten Sie die <strong>Reisewarnung</strong> und <strong>Ausreiseaufforderung</strong> für Mali.</span></li><li><span>Nutzen Sie kommerzielle Fluglinien zur Ausreise, solange noch Flüge durchgeführt werden. Im Falle einer weiteren Verschärfung der Sicherheitslage muss damit gerechnet werden, dass Flüge storniert und der Flugverkehr nach Mali eingestellt werden.</span></li><li><span>Prüfen Sie in jedem Einzelfall, ob Ihr Flug durchgeführt wird und ob Sie den Flughafen sicher erreichen können, bevor Sie sich zum Flughafen begeben.</span></li><li><span>Kontaktieren Sie bei Fragen zu gebuchten Flügen Ihre Fluggesellschaft.</span></li><li>Führen Sie stets einsatzfähige Kommunikationsmittel mit sich.</li><li>Meiden Sie Bewegungen im Stadtgebiet, Menschenansammlungen sowie Einrichtungen der malischen Sicherheitskräfte (z.B. Kasernen und andere militärische Anlagen) und Regierungsgebäude (z.B. Cité Administrative).</li><li><span>Achten Sie auf ausreichende Vorratshaltung (Wasser, Lebensmittel, Medikamente, Treibstoff). Sollte es zu Menschenansammlungen vor Tankstellen kommen, meiden Sie diese.</span></li></ul><h2>Sicherheit - Reisewarnung</h2><p>Siehe <em>Aktuelles</em></p><p><span><strong>Vor Reisen nach Mali wird gewarnt.</strong></span></p><p><strong>Deutsche Staatsangehörige werden aufgefordert, Mali auf dem Luftweg zu verlassen.</strong></p><p><span><strong>Vor Ausreisen über Land wird gewarnt, da die Nationalstraßen derzeit Ziele von Angriffen terroristischer Gruppen sind. </strong></span></p><h3>Terrorismus</h3><p><span>Anschläge sind in Mali überall und jederzeit möglich. Vorwiegend islamistische Terrorgruppen sind in ganz Mali aktiv, insbesondere im Norden und im Zentrum (Region Mopti) des Landes, vermehrt jedoch auch im Süden und um die Hauptstadt Bamako. Es kommt regelmäßig zu Anschlägen auf staatliche Sicherheitskräfte und militärischen Kampfhandlungen, die oft auch zivile Opfer fordern. In den nord-östlichen und zentralen Landesteilen sowie in Gebieten entlang der Grenzen zu Mauretanien, Burkina Faso und Côte d’Ivoire sind Terrorgruppen besonders aktiv. Zunehmend kommt es allerdings auch im Süden Malis, inklusive der Hauptstadt Bamako, zu Überfällen und terroristischen Angriffen sowie Kämpfen zwischen Sicherheitskräften und Terrorgruppen. </span></p><p><span>Für Angehörige westlicher Staaten besteht, insbesondere außerhalb von Bamako, ein hohes Risiko, Opfer von Entführungen und gezielten Anschlägen zu werden. Zudem stellen Landminen oder Sprengfallen eine ernstzunehmende Gefahr dar.</span></p><ul class=\"rte--list\"><li><span>Beachten Sie die <strong>Reisewarnung</strong> und <strong>Ausreiseaufforderung</strong> für Mali.</span></li><li><span>Machen Sie sich die auch in der Hauptstadt Bamako sowie deren Umgebung bestehende generelle Gefährdung durch terroristische Gruppen bewusst.</span></li><li><span>Seien Sie auch in der Hauptstadt Bamako besonders vorsichtig und meiden Sie nach Möglichkeit Orte und Ausflugsziele, die regelmäßig von Ausländern aufgesucht werden.</span></li><li><span>Meiden Sie Menschenansammlungen (insbesondere vor Tankstellen) sowie Einrichtungen der malischen Sicherheitskräfte (z.B. Kasernen und andere militärische Anlagen) und Regierungsgebäude (z.B. Cité Administrative) weiträumig.</span></li><li><span>Folgen Sie den Anweisungen lokaler Sicherheitskräfte.</span></li><li><span>Vermeiden Sie Überlandfahrten; reisen Sie keinesfalls nachts und treffen Sie stets Sicherheitsvorkehrungen.</span></li><li>Führen Sie stets einsatzfähige Kommunikationsmittel mit sich.</li><li><span>Beachten Sie den </span><a href=\"https://www.auswaertiges-amt.de/de/reiseundsicherheit/weltweiter-sicherheitshinweis-1796970\" target=\"_blank\" rel=\"noopener\" title=\"Weltweiter Sicherheitshinweis\"><span>weltweiten Sicherheitshinweis.</span></a></li></ul><h3>Innenpolitische Lage</h3><p>Seit 2020 wird das Land von Militärregierungen geführt. Die zuletzt für 2024 angekündigten Wahlen wurden ohne Angabe neuer Termine mehrfach verschoben.<span> Sicherheitsmaßnahmen, Personenüberprüfungen und Straßensperren können jederzeit stattfinden. </span></p><p><span>Kundgebungen, Protestaktionen und Demonstrationen können sich vereinzelt gegen westliche Personen oder Staaten richten. Unruhen und gewalttätige Auseinandersetzungen im Umfeld von Protesten sind nicht auszuschließen.</span></p><ul class=\"rte--list\"><li>Bleiben Sie an einem sicheren Ort.</li><li>Verhalten Sie sich umsichtig und wachsam.</li><li>Halten Sie sich über lokale Medien informiert.</li><li>Tragen Sie jederzeit Identitätspapiere mit sich und verhalten Sie sich kooperativ.</li><li>Meiden Sie Demonstrationen und größere Menschenansammlungen weiträumig.</li><li>Verzichten Sie auf Fotos von Brücken, öffentlichen sowie militärischen Einrichtungen, Regierungsgebäuden und Flughäfen. Fotografieren Sie Personen nur mit deren Einverständnis.</li><li>Folgen Sie den Anweisungen lokaler Sicherheitskräfte.</li><li><span>Achten Sie auf ausreichende Vorratshaltung (Wasser, Lebensmittel, Medikamente, Treibstoff).</span></li></ul><h3>Kriminalität</h3><p>Gewaltkriminalität trifft auch Ausländer. Es kommt zu Autodiebstählen, teils mit Waffengewalt, Kleinkriminalität wie Taschendiebstählen, Vorschussbetrügereien („Scams“) und Kreditkartenbetrügereien.</p><ul class=\"rte--list\"><li>Verzichten Sie auf alle Überlandfahrten</li><li>Vermeiden Sie unbedingt Fahrten in der Dunkelheit.</li><li>Bewahren Sie Geld, Ausweise, Führerschein und andere wichtige Dokumente sicher auf; speichern Sie ggf. elektronische Kopien/Fotos. Dies erleichtert im Falle von Diebstahl oder Verlust die Ausstellung eines Ersatzdokuments.</li><li>Bevorzugen Sie bargeldlose Zahlungen und nehmen Sie nur das für den Tag benötigte Bargeld und keine unnötigen Wertsachen mit.</li><li>Seien Sie an belebten Orten ( z.B. auf Märkten) besonders aufmerksam und achten Sie auf Ihre Wertsachen.</li><li>Seien Sie bei ungewohnten E-Mails, Telefonanrufen, Gewinnmitteilungen, Angeboten und Hilfeersuchen angeblicher Bekannter skeptisch. Teilen Sie keine Daten von sich mit, sondern vergewissern Sie sich ggf. <span>persönlich der Glaubwürdigkeit</span> oder wenden Sie sich an die Polizei.</li></ul><h2>Gesundheit</h2><h3>Impfschutz</h3><p class=\"berschrift4\"><em><span class=\"berschrift3Zchn\"><strong>Pflichtimpfungen:</strong></span></em></p>"
  }
};

/** The short advisory every country without a recorded one answers: no advice against anything. */
export const PLAIN_CONTENT =
  "<h2>Aktuelles</h2><p>Derzeit liegen keine besonderen Hinweise vor.</p>" +
  "<h2>Sicherheit</h2><h3>Kriminalität</h3><p>Achten Sie auf Ihre Wertsachen.</p>" +
  "<h2>Gesundheit</h2><h3>Impfschutz</h3><p>Prüfen Sie Ihren Impfschutz vor der Reise.</p>";

/** The disclaimer every advisory carries (shortened). */
export const DISCLAIMER =
  '<div class="infobox__content-wrapper"> <h3 class="infobox__headline">Haftungsausschluss</h3> <p>Planung und Antritt von Auslandsreisen stets in eigener Verantwortung!</p></div>';

/** What the mock serves; every part optional, the recorded data by default. */
export interface ReiseApiOptions {
  /** The countries of the list, by content id. */
  countries?: Readonly<Record<string, ListFixture>>;
  /** Advisories by content id (content and lastChanges); others answer PLAIN_CONTENT. */
  advisories?: Readonly<Record<string, { lastChanges: string; content: string }>>;
}

/** The list endpoint's answer for `countries`. */
export function listAnswer(countries: Readonly<Record<string, ListFixture>> = COUNTRIES): unknown {
  return { response: { lastModified: LIST_LAST_MODIFIED, contentList: Object.keys(countries), ...countries } };
}

/** One country's advisory answer, or undefined for an id the list doesn't hold. */
export function advisoryAnswer(id: string, options: ReiseApiOptions = {}): unknown {
  const entry = (options.countries ?? COUNTRIES)[id];
  if (entry === undefined) return undefined;
  const recorded = (options.advisories ?? ADVISORIES)[id];
  return {
    response: {
      [id]: {
        ...entry,
        lastChanges: recorded?.lastChanges ?? "Letzte Änderungen: <br><span>Redaktionelle Änderungen</span>",
        content: recorded?.content ?? PLAIN_CONTENT,
        disclaimer: DISCLAIMER,
      },
    },
  };
}

/** The mock's answer to `request`: the list, an advisory, or a 404 like the API's. */
export function reiseResponder(options: ReiseApiOptions = {}): (request: HttpRequest) => HttpResponse {
  return (request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path === "/opendata/travelwarning") return jsonResponse(listAnswer(options.countries));
    const match = /^\/opendata\/travelwarning\/(\d+)$/.exec(path);
    const answer = match === null ? undefined : advisoryAnswer(match[1] as string, options);
    return answer === undefined ? jsonResponse({ error: "not found" }, 404) : jsonResponse(answer);
  };
}

/** A mock transport serving the recorded API (or `options`), recording every request. */
export function reiseApi(options: ReiseApiOptions = {}): MockTransport {
  return makeMockTransport(reiseResponder(options));
}

/** Content ids of the recorded countries the tests name. */
export const THAILAND = "201558";
export const TUERKEI = "201962";
export const MALI = "208258";
export const OESTERREICH = "210962";
