// Which Latin letter a character from another script reads as: the plugin SDK's map, vendored here so the runtime's
// tag escaping (`lookalike-tags.ts`) reads a tag's letters exactly as Clover's own escaping (`turn-loop/defuse.ts`), its
// plugin name check (`foldTitle`) and its island do.
//
// VENDORED, NOT EDITED HERE. The source is Clover's `packages/plugin-sdk/src/catalogs/fold.ts` (#264), copied from
// clover main 6eea15436. Two checks keep the copies one map: `lookalike-fold.test.ts` pins this table's fingerprint,
// so an edit here fails until it is made on purpose, and Clover's own test compares this export with the plugin SDK's
// `lookalikeOf` over every code point, so either side drifting fails Clover's gate. A change goes to fold.ts first,
// then here, then the fingerprint.

/** Letters from other scripts that read as Latin ones (a short table after Unicode's confusables, UTS #39), and the
 *  digits and strokes that read as letters. */
const CONFUSABLES: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic
  ..."АaВbЕeКkМmНhОoРpСcТtХxУyІlЈjЅsҮyҺhӀlԚqԜwаaеeоoрpсcуyхxіiјjѕsԁdһhӏlԛqԝwүyёeїiгrпn".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Greek
  ..."ΑaΒbΕeΖzΗhΙlΚkΜmΝnΟoΡpΤtΥyΧxαaβbεeιiκkνvοoρpτtυuχxγyωw".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Latin lookalikes, Armenian, digits and strokes
  ..."ıiɩiɑaɡgʏyℓlǀlօoսuցgհhոn0o1l|l".match(/../gu)!.map((p) => [...p] as [string, string]),
]);

/** Small capitals and Cherokee letters that read as Latin ones (lane G's island comparison, kept in agreement). */
const LOOKALIKES: Readonly<Record<string, string>> = Object.fromEntries([
  // Small capitals
  ..."ᴀaʙbᴄcᴅdᴇeꜰfɢgʜhɪiᴊjᴋkʟlᴍmɴnᴏoᴘpǫqʀrꜱsᴛtᴜuᴠvᴡwʏyᴢz".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Letters with a stroke or hook, which NFD leaves whole (#187's review): đ ł ø ƚ ɗ ħ ŧ ɍ and their kin
  ..."đdĐdɗdƊdłlŁlƚlȽlɫlɬløoØoǿoǾoħhĦhŧtŦtɍrɌrƀbɃbɨiƗiʉuɄuǥgǤgɇeɆeɉjɈjƶzƵzȼcȻcꝁkꝀkƥpƤpɓbƁbƈcƇcɠgƓgƙkƘkƴyƳyȥzȤz".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Greek lunate sigma (mapped before NFKC, which would make it Σ), and other letters that read as Latin ones
  ..."ϲcϹcყyɘeѻoѺo○o◯oᏁnᏑn".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Lisu (U+A4D0–A4FF), whose letters are Latin capitals, some turned; its tone marks are dropped
  ..."ꓐbꓑpꓒdꓓdꓔtꓕtꓖgꓗkꓘkꓙjꓚcꓛcꓜzꓝfꓞfꓟmꓠnꓡlꓢsꓣrꓤrꓥvꓦvꓧhꓨhꓩfꓪwꓫxꓬyꓭgꓮaꓯaꓰeꓱeꓲlꓳoꓴuꓵuꓶuꓷo".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Cherokee capitals (a small letter is upper-cased to its capital first)
  ..."ᎪaᏴbᏟcᎠdᎬeᏀgᎻhᏆlᎫjᏦkᏞlᎷmᏢpᏒrᏚsᎢtᏙvᎳwᏔwᎩyᏃz".match(/../gu)!.map((p) => [...p] as [string, string]),
]);
/** The island's own lookalike tables (lane G, before #264), folded in so the manifest check refuses everything the
 *  island did: Cyrillic, Greek, Armenian and Cherokee letters that read as Latin ones, in both cases, and Latin's
 *  small capitals. One entry of theirs is left out as too loose: Greek η, which reads as an "n" only in some faces. */
const ISLAND_LOOKALIKES: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic capitals and small letters
  ..."АaВbЕeЁeЗ3КkМmНhОoРpСcТtУyХxЅsІlЇlЈjҮyԚqԜwӀlꙆl".match(/../gu)!.map((p) => [...p] as [string, string]),
  ..."аaвbеeёeгrз3кkмmнhоoпnрpсcтtуyхxѕsіlїlјjԁdһhӏlԛqԝwүyҽeѵvꙇl".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Greek capitals and small letters (σ and ς read as "o" and "c"; ϲ, Ϲ and ϳ, Ϳ too)
  ..."ΑaΒbΕeΖzΗhΙlΚkΜmΝnΟoΡpΤtΥyΧxϹcͿj".match(/../gu)!.map((p) => [...p] as [string, string]),
  ..."αaβbγyεeιlκkνvοoρpσoτtυuχxϲcϳjςc".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Armenian capitals and small letters
  ..."ՏsՕoՍuաwզqհhոnսuօo".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Cherokee capitals (a small letter is upper-cased to its capital first)
  ..."ᎪaᏴbᏟcᎠdᎬeᏀgᎻhᎥlᎫjᏦkᏞlᎷmᏫoᏢpᏚsᎢtᏙvᎳwᏃz".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Latin lookalikes
  ..."ɑaɡgıiȷjɩiʋuɣyꞵbǀl".match(/../gu)!.map((p) => [...p] as [string, string]),
]);

/** Every lookalike, one map: the confusables, the small capitals and Latin letters with a stroke, and the island's. */
const LOOKALIKE: Readonly<Record<string, string>> = { ...ISLAND_LOOKALIKES, ...LOOKALIKES, ...CONFUSABLES };

/** The Latin letter a character reads as, or undefined when it reads as itself (the merged map foldTitle uses). */
export function lookalikeOf(ch: string): string | undefined {
  return LOOKALIKE[ch];
}

/** Every entry of the map, sorted by character: what the fingerprint and Clover's agreement test read. */
export function lookalikeEntries(): Array<[string, string]> {
  return Object.entries(LOOKALIKE).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
