/**
 * Prose generation, behind a swappable engine.
 *
 * The default `TemplateContentEngine` is deterministic and offline: it composes
 * titles and body copy from sentence frames filled with terms taken from the
 * topic. That is a deliberate choice, not a limitation — this tool's job is to
 * make a *theme* look real, which needs plausible headlines, sensible heading
 * hierarchy and paragraphs of realistic length and rhythm. It does not need
 * copy anyone will read closely, and a template engine gives reproducible runs
 * with no key, no cost and no latency.
 *
 * When better prose matters, there are two routes that need no code change:
 *   - pass `titles`/`outlines` into the generator (an MCP host model can write
 *     them and let themeseed handle structure, images and publishing), or
 *   - implement `ContentEngine` against a model API and pass it in.
 */

import type { ContentBlock } from '../core/types.js';
import { hashString, seededRandom } from '../images/png.js';

export interface OutlineRequest {
  title: string;
  topic: string;
  /** Words of body copy to aim for. */
  targetWords: number;
  /** Deterministic seed so the same post regenerates identically. */
  seed: number;
}

export interface ContentEngine {
  readonly name: string;
  generateTitles(topic: string, count: number, seed: number): Promise<string[]>;
  /** Body copy only: no images, galleries or videos — the generator adds those. */
  generateBody(request: OutlineRequest): Promise<ContentBlock[]>;
  generateExcerpt(title: string, topic: string, seed: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Topic vocabulary
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'about',
  'blog', 'site', 'website', 'magazine', 'publication', 'newsletter',
]);

export interface TopicProfile {
  /** The full topic string as given. */
  raw: string;
  /** Primary noun phrase, e.g. "SaaS productivity". */
  subject: string;
  /** Content words, lowercased. */
  terms: string[];
  /** Adjectival form used in running text, e.g. "SaaS productivity". */
  qualifier: string;
}

export function profileTopic(topic: string): TopicProfile {
  const cleaned = topic.trim().replace(/\s+/g, ' ');
  const words = cleaned.split(' ').filter(Boolean);
  const terms = words.filter((word) => !STOPWORDS.has(word.toLowerCase()));

  // Take the first clause only. "urban cycling and city infrastructure" is two
  // noun phrases; concatenating across the conjunction produces "urban cycling
  // city", which reads as nonsense in every headline it lands in.
  const firstClause = cleaned.split(/\s*(?:,|;| and | or | & |\/)\s*/i)[0] ?? cleaned;
  const clauseTerms = firstClause.split(' ').filter((word) => !STOPWORDS.has(word.toLowerCase()));

  const subject =
    (clauseTerms.length ? clauseTerms : terms.length ? terms : words).slice(0, 3).join(' ') ||
    cleaned ||
    'the subject';

  return {
    raw: cleaned,
    subject,
    terms: terms.map((term) => term.toLowerCase()),
    qualifier: subject,
  };
}

// ---------------------------------------------------------------------------
// Article shapes
// ---------------------------------------------------------------------------

type Angle = 'guide' | 'listicle' | 'opinion' | 'case-study' | 'explainer';

const ANGLES: Angle[] = ['guide', 'listicle', 'opinion', 'case-study', 'explainer'];

const TITLE_FRAMES: Record<Angle, string[]> = {
  guide: [
    'A practical guide to {subject}',
    'Getting started with {subject}, properly',
    'How to think about {subject}',
    'The {subject} playbook we actually use',
    'Setting up {subject} without the guesswork',
  ],
  listicle: [
    '{n} things nobody tells you about {subject}',
    '{n} {subject} habits worth stealing',
    '{n} mistakes that quietly derail {subject}',
    '{n} small changes that improve {subject}',
  ],
  opinion: [
    'Why {subject} is harder than it looks',
    '{subject} has a measurement problem',
    'Against the usual advice on {subject}',
    'The case for doing less with {subject}',
    'We were wrong about {subject}',
  ],
  'case-study': [
    'What six months of {subject} taught us',
    'Rebuilding our approach to {subject}',
    'A post-mortem on our {subject} rollout',
    'How one team fixed {subject}',
  ],
  explainer: [
    '{subject}, explained without the jargon',
    'What {subject} actually means',
    'The anatomy of good {subject}',
    'A short history of {subject}',
    '{subject}: the parts that matter',
  ],
};

const SECTION_HEADINGS: Record<Angle, string[]> = {
  guide: [
    'Start with the constraints',
    'The setup',
    'Where teams go wrong',
    'Making it stick',
    'A worked example',
    'Choosing what to measure',
    'The first month',
    'When to change course',
    'Handing it over',
  ],
  listicle: [
    'Begin with the obvious one',
    'The one people skip',
    'The expensive mistake',
    'The habit that compounds',
    'What to do first',
    'The one that only matters at scale',
    'The advice worth ignoring',
    'The quiet win',
    'Where to start on Monday',
  ],
  opinion: [
    'The received wisdom',
    'What the data actually shows',
    'A different reading',
    'The objection worth taking seriously',
    'Where this leaves us',
    'How we got here',
    'The incentive problem',
    'What would change our mind',
    'A more modest claim',
  ],
  'case-study': [
    'The situation',
    'What we tried first',
    'What changed',
    'The numbers',
    'What we would do differently',
    'The part that surprised us',
    'What it cost',
    'How we knew it was working',
    'Where it still breaks',
  ],
  explainer: [
    'The short version',
    'How it works',
    'Why it is confusing',
    'The edge cases',
    'Putting it together',
    'A common misreading',
    'The vocabulary problem',
    'What it is not',
    'Where to go deeper',
  ],
};

const OPENERS = [
  'Most teams arrive at {subject} the same way: something breaks, and the fix becomes a habit.',
  'There is no shortage of advice about {subject}. There is a shortage of advice that survives contact with a real week.',
  'Ask ten people to define {subject} and you will get ten answers, most of them describing a symptom rather than the thing itself.',
  '{Subject} is one of those topics where the obvious answer is right about sixty per cent of the time, which is exactly often enough to be dangerous.',
  'The interesting thing about {subject} is how rarely the hard part is the part everyone prepares for.',
  'We spent a quarter trying to get {subject} right, and the useful lessons were not the ones we expected.',
];

/**
 * Body copy is composed rather than picked whole: each paragraph is a claim,
 * an elaboration, and usually an example or a caveat.
 *
 * The reason is length. A theme with a table of contents wants ~1400 words,
 * which is roughly twenty paragraphs; drawing those from a flat list of twenty
 * fixed paragraphs would repeat visibly and read as filler. Composing three
 * sentences from three pools instead yields thousands of distinct paragraphs
 * from a few dozen written lines, and keeps a long article varied.
 */
const CLAIMS = [
  'The first thing to establish is what you are actually optimising for.',
  'It helps to separate the decision from the execution.',
  'The compounding effects matter far more than the individual wins.',
  'Measurement is usually where this falls apart.',
  'Consider the failure mode rather than the success case.',
  'Most of the difficulty lives at the boundaries, not in the middle.',
  'There is a version of {subject} that is mostly ritual.',
  'The default answer is right often enough to be dangerous.',
  'Scope is the variable everyone adjusts last and should adjust first.',
  'Speed and reversibility are the trade-off worth naming out loud.',
  'The tooling question is downstream of the constraint question.',
  'What looks like a process problem is frequently an ownership problem.',
  'Consistency is worth more than any individual improvement to {subject}.',
  'The expensive mistakes here are rarely the technical ones.',
  'Feedback loops shorter than the planning cycle change everything.',
  'Nobody gets credit for the work that did not need doing.',
  'The second-order effects arrive about a quarter after the first-order ones.',
  'Documentation is a symptom: you write it where the design is unclear.',
  'A shared definition of "done" removes more friction than any tool.',
  'The interesting constraint is almost never the one in the brief.',
];

const ELABORATIONS = [
  '{Subject} rewards clarity here more than almost anywhere else, because the wrong target produces work that looks productive and moves nothing.',
  'The decision is usually cheap and reversible; the execution is where the cost lives, and that is where the argument should have happened.',
  'A small improvement applied consistently beats a dramatic one applied once, which is unsatisfying advice precisely because it is correct.',
  'The things that are easy to count are rarely the things that matter, and once a number reaches a dashboard it starts shaping behaviour whether or not it deserves to.',
  'Success has many causes and teaches very little; failure tends to have one, and it is usually obvious in hindsight.',
  'Handoffs between people who each hold a coherent local picture and no shared one produce most of the pain later attributed to tooling.',
  'It is comfortable, it is legible to management, and it is close to worthless once you measure what it actually changes.',
  'Being right sixty per cent of the time builds exactly the kind of confidence that makes the other forty per cent expensive.',
  'Cutting scope early is cheap and slightly embarrassing; cutting it late is expensive and deeply embarrassing.',
  'Teams that pick both end up with neither, and usually discover this at the point where reversing would have mattered.',
  'Choosing infrastructure before agreeing what it is for is how organisations end up maintaining a system nobody wanted.',
  'When responsibility is spread across a group, the work that falls between the named parts is the work that does not happen.',
  'A team that changes approach every quarter pays a coordination tax that routinely exceeds whatever the change was meant to fix.',
  'They are decisions made quickly, defended slowly, and built upon for six months before anyone recalculates.',
  'If you learn on Friday what you assumed on Monday, the assumption never has time to become an architecture.',
  'Subtraction is structurally underrated: the meeting that stopped happening leaves no artefact to point at in a review.',
  'The first quarter shows the intended effect; the second shows what the intended effect displaced.',
  'Where a design is obvious the prose is short, so the length of an explanation is a reasonable proxy for where to look next.',
  'Most disagreements that present as strategic turn out, on inspection, to be two people using one word for two things.',
  'The stated constraint is usually a proxy for a real one nobody wants to say aloud, and optimising the proxy is wasted effort.',
];

const EXAMPLES = [
  'A useful test: if this disappeared tomorrow, how long before anyone noticed?',
  'One team we spoke to cut their review stage entirely and found throughput unchanged, which told them something the metrics had not.',
  'Try writing the constraint on one line before opening a vendor comparison; the line is usually harder than the comparison.',
  'The version of this that works fits on an index card. The version that fails needs an onboarding session.',
  'Ask what would have to be true for the opposite approach to be correct, and see whether anyone can answer.',
  'We ran both approaches in parallel for six weeks. The difference was smaller than the cost of the debate about it.',
  'In practice the answer showed up in the calendar before it showed up in the dashboard.',
  'The clearest signal was that people stopped asking where things were.',
  'Set a date at which you will stop, and write down in advance what would make you stop earlier.',
  'When we mapped it out, four of the seven steps existed only to compensate for the second one.',
];

const CAVEATS = [
  'That said, none of this generalises cleanly across team sizes.',
  'The counter-argument deserves a hearing, and it is stronger than its usual proponents make it sound.',
  'This is easier to write than to hold to when a deadline appears.',
  'There are organisations where the opposite is true, and they are not obviously worse off.',
  'The evidence here is thinner than anyone quoting it tends to admit.',
  'It is worth saying that we have not run this long enough to be confident.',
  'Reasonable people land elsewhere on this, usually because their constraints differ more than the vocabulary suggests.',
  'The caveat is that all of this assumes the underlying goal is settled, which is frequently the actual problem.',
];

const CLOSERS = [
  'None of this generalises perfectly. Take the parts that map onto your constraints and discard the rest — that is what the framing is for.',
  'The short version: decide what you are optimising for, write it down, and revisit it when the answer stops feeling obvious.',
  'If there is one thing worth carrying away, it is that the expensive mistakes in {subject} are almost never technical ones.',
  'We will revisit this once we have another two quarters of data. The current answer feels right, which is exactly when it is worth checking.',
];

const QUOTES = [
  'The bottleneck is never where you think it is — that is what makes it a bottleneck.',
  'Every process is perfectly designed to get the results it gets.',
  'You can have it fast, or you can have it reversible. Pick before you start, not after.',
  'The cost of a bad decision is rarely the decision. It is the six months of building on top of it.',
  'Simplicity is not the absence of work. It is the result of it.',
];

const LIST_INTROS = [
  'A few things worth checking before you commit:',
  'The checklist we ended up with:',
  'What we look for now:',
];

const LIST_ITEMS = [
  'Write the constraint down before choosing a tool',
  'Agree on what "done" means, in writing, before starting',
  'Name one person accountable — not a group',
  'Decide in advance what would make you stop',
  'Keep the feedback loop shorter than the planning cycle',
  'Prefer the reversible option when the evidence is thin',
  'Review the numbers monthly; change the targets rarely',
];

// ---------------------------------------------------------------------------
// Template engine
// ---------------------------------------------------------------------------

export class TemplateContentEngine implements ContentEngine {
  readonly name = 'template';

  async generateTitles(topic: string, count: number, seed: number): Promise<string[]> {
    const profile = profileTopic(topic);
    const random = seededRandom(seed);
    const titles: string[] = [];
    const seen = new Set<string>();

    // Cycle the angles so a batch is varied rather than five guides in a row.
    for (let index = 0; titles.length < count && index < count * 8; index++) {
      const angle = ANGLES[index % ANGLES.length]!;
      const frames = TITLE_FRAMES[angle];
      const frame = frames[Math.floor(random() * frames.length)]!;
      // Frames that begin with {subject} would otherwise inherit the topic's
      // casing and produce a headline starting in lower case.
      const title = sentenceCase(fill(frame, profile, { n: 3 + Math.floor(random() * 6) }));
      if (seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      titles.push(title);
    }

    // If the frames could not produce enough distinct titles, number the rest
    // rather than returning fewer than asked for.
    let suffix = 2;
    while (titles.length < count) {
      const base = titles[titles.length % Math.max(1, titles.length)] ?? profile.subject;
      titles.push(`${base} (part ${suffix++})`);
    }

    return titles.slice(0, count);
  }

  async generateExcerpt(title: string, topic: string, seed: number): Promise<string> {
    const profile = profileTopic(topic);
    const random = seededRandom(seed ^ 0x9e3779b9);
    const frame = OPENERS[Math.floor(random() * OPENERS.length)]!;
    const sentence = fill(frame, profile, {});
    return sentence.length > 280 ? `${sentence.slice(0, 277).trimEnd()}…` : sentence;
  }

  async generateBody(request: OutlineRequest): Promise<ContentBlock[]> {
    const profile = profileTopic(request.topic);
    const random = seededRandom(request.seed);
    const angle = ANGLES[Math.floor(random() * ANGLES.length)]!;

    const blocks: ContentBlock[] = [];
    let words = 0;
    const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

    const push = (block: ContentBlock, text: string) => {
      blocks.push(block);
      words += countWords(text);
    };

    // Opening paragraph, before any heading — themes render the first
    // paragraph differently often enough that it should always exist.
    const opener = fill(pick(OPENERS, random), profile, {});
    push({ type: 'paragraph', text: opener }, opener);

    const headings = shuffle(SECTION_HEADINGS[angle], random);
    // Independent rotating decks, so a sentence is not reused until its pool
    // is exhausted — that is what keeps a 1400-word article from repeating.
    const claims = new Deck(CLAIMS, random);
    const elaborations = new Deck(ELABORATIONS, random);
    const examples = new Deck(EXAMPLES, random);
    const caveats = new Deck(CAVEATS, random);

    let quoteUsed = false;
    let listUsed = false;
    let headingIndex = 0;

    // Keep adding sections until the target is met. Headings cycle if a theme
    // wants a longer article than there are distinct headings for.
    while (words < request.targetWords && headingIndex < headings.length * 2) {
      const heading = headings[headingIndex % headings.length]!;
      headingIndex += 1;
      push({ type: 'heading', level: 2, text: heading }, heading);

      const paragraphsInSection = 2 + Math.floor(random() * 2);
      for (let i = 0; i < paragraphsInSection && words < request.targetWords; i++) {
        const sentences = [fill(claims.next(), profile, {}), fill(elaborations.next(), profile, {})];
        // A third sentence roughly two thirds of the time, so paragraph length
        // varies the way real writing does rather than marching in lockstep.
        const roll = random();
        if (roll > 0.62) sentences.push(fill(examples.next(), profile, {}));
        else if (roll > 0.34) sentences.push(fill(caveats.next(), profile, {}));

        const text = sentences.join(' ');
        push({ type: 'paragraph', text }, text);
      }

      // One quote and one list per article, placed mid-way so they break up
      // the run of paragraphs rather than clustering at the end.
      if (!quoteUsed && words > request.targetWords * 0.35 && random() > 0.4) {
        quoteUsed = true;
        const quote = pick(QUOTES, random);
        push({ type: 'quote', text: quote, attribution: 'Overheard in a retrospective' }, quote);
      }

      if (!listUsed && words > request.targetWords * 0.5 && random() > 0.45) {
        listUsed = true;
        const intro = pick(LIST_INTROS, random);
        push({ type: 'paragraph', text: intro }, intro);
        const items = shuffle(LIST_ITEMS, random).slice(0, 3 + Math.floor(random() * 3));
        push({ type: 'list', ordered: random() > 0.5, items }, items.join(' '));
      }
    }

    const closer = fill(pick(CLOSERS, random), profile, {});
    push({ type: 'paragraph', text: closer }, closer);

    return blocks;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fill(frame: string, profile: TopicProfile, vars: { n?: number }): string {
  return frame
    .replace(/\{subject\}/g, profile.subject)
    .replace(/\{Subject\}/g, capitalise(profile.subject))
    .replace(/\{n\}/g, String(vars.n ?? 5));
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Capitalises the very first character, and only that one.
 *
 * Deliberately does not skip ahead to the first letter: "6 mistakes that…"
 * starts with a numeral and the word after it stays lower case, the way a real
 * headline would be written. Acronyms further along keep their own casing, so
 * "SaaS" never becomes "Saas".
 */
export function sentenceCase(text: string): string {
  if (!text) return text;
  const first = text.charAt(0);
  return /[a-z]/.test(first) ? first.toUpperCase() + text.slice(1) : text;
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

/**
 * Draws without replacement, reshuffling once the pool runs out.
 *
 * Sampling independently would repeat a sentence three paragraphs later often
 * enough to notice; this guarantees maximum spacing between reuses.
 */
class Deck<T> {
  private remaining: T[];

  constructor(
    private readonly items: readonly T[],
    private readonly random: () => number
  ) {
    this.remaining = shuffle(items, random);
  }

  next(): T {
    if (this.remaining.length === 0) this.remaining = shuffle(this.items, this.random);
    return this.remaining.pop()!;
  }
}

/** Fisher-Yates against the seeded PRNG, so shuffles are reproducible. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export { hashString };
