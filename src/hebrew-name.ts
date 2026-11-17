// Latin-script profile names in a Hebrew WhatsApp greeting flip the line's
// direction (the first strong character is Latin). The first-reply renderer
// transliterates a usable first name into Hebrew letters, or omits it when
// the spelling is uncertain — never write Latin in a Hebrew greeting.

const HEBREW_RE = /[\u0590-\u05FF]/;
const LATIN_RE = /[A-Za-z]/;

// Irregular or conventional spellings that a letter-by-letter map would miss
// (David would otherwise become דויד, Noa would become נוה).
const EXCEPTIONS: Record<string, string> = {
  ilan: "אילן",
  david: "דוד",
  dave: "דייב",
  michael: "מיכאל",
  michal: "מיכל",
  michelle: "מישל",
  michel: "מישל",
  sarah: "שרה",
  sara: "שרה",
  rachel: "רחל",
  racheli: "רחלי",
  rebecca: "רבקה",
  rivka: "רבקה",
  isaac: "יצחק",
  yitzhak: "יצחק",
  itzhak: "יצחק",
  itzik: "איציק",
  jacob: "יעקב",
  yaakov: "יעקב",
  yakov: "יעקב",
  joseph: "יוסף",
  yosef: "יוסף",
  yossi: "יוסי",
  moshe: "משה",
  moses: "משה",
  abraham: "אברהם",
  avraham: "אברהם",
  samuel: "שמואל",
  shmuel: "שמואל",
  jonathan: "יונתן",
  yonatan: "יונתן",
  yonathan: "יונתן",
  benjamin: "בנימין",
  binyamin: "בנימין",
  elijah: "אליהו",
  eliyahu: "אליהו",
  noa: "נועה",
  noah: "נח",
  maya: "מאיה",
  maia: "מאיה",
  yael: "יעל",
  daniel: "דניאל",
  danny: "דני",
  dani: "דני",
  john: "ג'ון",
  james: "ג'יימס",
  william: "ויליאם",
  thomas: "תומס",
  alexander: "אלכסנדר",
  alex: "אלכס",
  sasha: "סשה",
  joshua: "יהושע",
  yehoshua: "יהושע",
  matthew: "מתיו",
  matt: "מאט",
  steven: "סטיבן",
  stephen: "סטיבן",
  steve: "סטיב",
  peter: "פיטר",
  paul: "פול",
  andrew: "אנדרו",
  robert: "רוברט",
  richard: "ריצ'רד",
  charles: "צ'ארלס",
  christopher: "כריסטופר",
  chris: "כריס",
};

const CLUSTERS: Array<[RegExp, string]> = [
  [/^sh/, "ש"],
  [/^ch|^kh/, "ח"],
  [/^tz|^ts/, "צ"],
  [/^ph/, "פ"],
  [/^th/, "ת"],
];

const CONSONANTS: Record<string, string> = {
  b: "ב", c: "ק", d: "ד", f: "פ", g: "ג", h: "ה",
  j: "ג'", k: "ק", l: "ל", m: "מ", n: "נ", p: "פ",
  q: "ק", r: "ר", s: "ס", t: "ט", v: "ו", w: "ו", z: "ז",
  x: "קס",
};

const FINALS: Record<string, string> = { כ: "ך", מ: "ם", נ: "ן", פ: "ף", צ: "ץ" };

function applyFinalForms(he: string): string {
  if (!he) return he;
  const last = he[he.length - 1]!;
  return FINALS[last] ? he.slice(0, -1) + FINALS[last] : he;
}

function phoneticToHebrew(latin: string): string | null {
  let i = 0;
  const s = latin.toLowerCase();
  const out: string[] = [];

  while (i < s.length) {
    const rest = s.slice(i);
    const cluster = CLUSTERS.find(([re]) => re.test(rest));
    if (cluster) {
      out.push(cluster[1]);
      i += rest.match(cluster[0])![0].length;
      continue;
    }

    const c = s[i]!;
    const start = i === 0;
    const end = i === s.length - 1;

    if (c === "a") {
      if (start) out.push("א");
      else if (end) out.push("ה");
      else if (out[out.length - 1] === "י" || out[out.length - 1] === "ו") out.push("א");
      i += 1;
      continue;
    }
    if (c === "e") {
      if (start) out.push("א");
      i += 1;
      continue;
    }
    if (c === "i" || c === "y") {
      out.push(start ? "אי" : "י");
      i += 1;
      continue;
    }
    if (c === "o" || c === "u") {
      out.push(start ? "או" : "ו");
      i += 1;
      continue;
    }
    if (c === "'" || c === "’" || c === "-") {
      i += 1;
      continue;
    }
    const mapped = CONSONANTS[c];
    if (!mapped) return null;
    out.push(mapped);
    i += 1;
  }

  const he = applyFinalForms(out.join(""));
  return he || null;
}

/**
 * A name that is safe to drop into a Hebrew greeting, or null to omit it
 * (the no-name text is used instead). Already-Hebrew names pass through.
 * Latin names are transliterated; when the spelling is uncertain, returns null
 * rather than leaving Latin letters in the line.
 */
export function hebrewGreetingName(name: string | null | undefined): string | null {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  const first = raw.split(/\s+/)[0] ?? "";
  if (!first) return null;
  if (HEBREW_RE.test(first) && !LATIN_RE.test(first)) return first;
  const key = first.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (EXCEPTIONS[key]) return EXCEPTIONS[key];
  if (!/^[A-Za-z]+(?:['’\-]?[A-Za-z]+)*$/.test(first)) return null;
  if (key.length < 2) return null;
  return phoneticToHebrew(key);
}
