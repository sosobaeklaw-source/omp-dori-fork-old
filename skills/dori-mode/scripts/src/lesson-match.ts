// Whether a repo lesson's rule is about a brief: some word of the rule matches some word of the brief. Words are
// lowercased letter/digit runs; number-only words and words that fit almost any brief never count.
const COMMON_WORDS = new Set(
  "the and for are not our you was its can all use run to of in on is it be as at by or an if do no we that this with from have will when your their before after into only must should work using then fix check make add update new also any need keep get see".split(
    " ",
  ),
);
// One trailing Korean particle, so "테스트는" and "테스트를" both read as "테스트". The stem keeps at least two syllables.
const PARTICLE =
  /^(\p{Script=Hangul}{2,}?)(?:에서|으로|까지|부터|에게|한테|처럼|보다|은|는|이|가|을|를|에|의|도|로|와|과|만)$/u;

const words = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !/^\p{N}+$/u.test(word) && !COMMON_WORDS.has(word))
    .map((word) => PARTICLE.exec(word)?.[1] ?? word)
    .filter((word) => word.length >= 2 || /[^\p{ASCII}]/u.test(word));

// Latin words of 4+ letters match when the longer one starts with the shorter one's first 6 letters ("test"/"tests",
// "deploy"/"deployment", not "config"/"confirm"); other scripts match when one word starts the other ("확인"/"확인서").
// Shorter words must be equal.
const same = (a: string, b: string): boolean => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const latin = /^[\p{ASCII}]+$/u.test(short);
  if (short.length < (latin ? 4 : 2)) return short === long;
  return long.startsWith(latin ? short.slice(0, 6) : short);
};

export const briefMatcher = (brief: string): ((rule: string) => boolean) => {
  const terms = words(brief);
  return (rule) => words(rule).some((word) => terms.some((term) => same(word, term)));
};
