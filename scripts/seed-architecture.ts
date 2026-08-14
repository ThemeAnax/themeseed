/**
 * A worked example of the `ContentEngine` extension point.
 *
 * The built-in template engine writes domain-neutral copy — fine for judging a
 * layout, obviously generic if you actually read it. This script swaps in a
 * contemporary-architecture content pack: real headlines, a bespoke opening
 * paragraph per article, and a pool of subject-specific sentences composed into
 * the body.
 *
 * Everything else still runs through themeseed unchanged — theme analysis,
 * Unsplash image sourcing, capability gating, Lexical conversion, publishing
 * and `#themeseed` tagging — which is the point: supplying better prose does
 * not mean rebuilding the pipeline.
 *
 *   npx tsx scripts/seed-architecture.ts [--count 10] [--draft] [--site <slug>]
 */

import 'dotenv/config';

import { resolveSite } from '../src/config/sites.js';
import { describeError } from '../src/core/errors.js';
import { seedSite } from '../src/core/seed.js';
import type { ContentBlock, PublishStatus } from '../src/core/types.js';
import type { ContentEngine, OutlineRequest } from '../src/content/engine.js';
import { hashString, seededRandom } from '../src/images/png.js';

// ---------------------------------------------------------------------------
// The articles
// ---------------------------------------------------------------------------

interface Article {
  title: string;
  excerpt: string;
  /** Sets the specific subject before the composed body takes over. */
  opener: string;
  /** Section headings particular to this piece. */
  headings: string[];
  /** Search terms for the feature image. */
  imageQuery: string;
}

const ARTICLES: Article[] = [
  {
    title: 'The quiet return of load-bearing masonry',
    excerpt:
      'Structural brick never actually went away — it just stopped being taught. A generation of architects is rediscovering why it was worth teaching.',
    opener:
      'For most of the twentieth century, brick stopped holding buildings up and started hanging off them. The structure moved to a steel or concrete frame, the masonry became a 100mm skin pinned to it, and an entire body of knowledge about how to build in compression quietly left the profession. It is coming back, and not for the reasons people assume.',
    headings: [
      'What we lost when brick became cladding',
      'The compression argument',
      'Detailing without a cavity',
      'Where it still does not work',
      'What to specify',
    ],
    imageQuery: 'brick masonry building facade architecture',
  },
  {
    title: 'Mass timber has an insurance problem',
    excerpt:
      'The engineering is settled and the carbon case is strong. The thing actually stopping CLT towers is a underwriting spreadsheet.',
    opener:
      'Ask why there are not more cross-laminated timber buildings and you will usually be told something about fire. That answer is a decade out of date — charring rates are well characterised, and encapsulated CLT behaves predictably enough that most codes now accommodate it. The real obstacle is duller and harder to design around: getting the building insured during construction.',
    headings: [
      'The fire question is mostly settled',
      'What underwriters actually price',
      'The construction-phase gap',
      'How projects are getting through it',
      'What changes this',
    ],
    imageQuery: 'cross laminated timber building interior architecture',
  },
  {
    title: 'What Passivhaus actually costs',
    excerpt:
      'The premium is real, smaller than the sceptics claim, larger than the advocates admit, and almost entirely front-loaded into decisions made before planning.',
    opener:
      'Every conversation about Passivhaus arrives at the same question and then leaves without answering it. The honest answer is that the cost premium is somewhere between two and twelve per cent, that the range is that wide because it depends almost entirely on decisions made in the first fortnight, and that a project which commits late pays the top of the range for the bottom of the benefit.',
    headings: [
      'Where the premium actually sits',
      'The form factor problem',
      'Why late commitment is expensive',
      'What the modelling misses',
      'The operational side of the ledger',
    ],
    imageQuery: 'modern energy efficient house architecture exterior',
  },
  {
    title: 'Against the glass box',
    excerpt:
      'Full-height glazing solved a problem architecture no longer has, and created several it now cannot afford.',
    opener:
      'The floor-to-ceiling glass curtain wall was an argument about lightness, transparency and the dissolution of the wall — and it was a good argument in 1952, when the alternative was a load-bearing perimeter and small punched openings. It is a much weaker argument now that the wall is a performance component and the glass is the worst-performing part of it.',
    headings: [
      'What the curtain wall was arguing against',
      'The performance arithmetic',
      'Glare, and the blinds nobody photographs',
      'The steel-man for glazing',
      'What replaces it',
    ],
    imageQuery: 'glass curtain wall office building architecture',
  },
  {
    title: 'Adaptive reuse is the only honest sustainability',
    excerpt:
      'The greenest building is still the one that already exists — and the embodied carbon numbers have stopped being arguable.',
    opener:
      'There is a version of sustainable architecture that consists of demolishing a serviceable 1970s building and replacing it with a highly efficient new one, then publishing the operational energy figures. The operational figures are genuinely better. The whole-life figures, once demolition and new material are counted honestly, frequently are not — and it takes decades of efficient operation to pay back what the demolition spent in an afternoon.',
    headings: [
      'The payback period nobody publishes',
      'Reading an existing frame',
      'Where reuse genuinely fails',
      'The planning and finance friction',
      'What a good survey looks like',
    ],
    imageQuery: 'adaptive reuse converted warehouse building architecture',
  },
  {
    title: 'The courtyard is having a moment, again',
    excerpt:
      'A four-thousand-year-old plan is being rediscovered by architects who mostly think they invented it.',
    opener:
      'The courtyard is the oldest environmental strategy in architecture and the one most reliably forgotten. It provides daylight to a deep plan, cross-ventilation without exposing a facade, defensible outdoor space on a tight urban site, and a thermal buffer — all from a single move that costs nothing but floor area. It keeps returning because the problems it solves keep returning.',
    headings: [
      'What the plan actually does',
      'Proportion is the whole game',
      'Daylight in a deep plan',
      'The floor-area objection',
      'Contemporary variations',
    ],
    imageQuery: 'courtyard house architecture modern',
  },
  {
    title: 'Why contemporary facades keep getting deeper',
    excerpt:
      'The flush facade was a twenty-year detour. Depth is back, and it is doing structural, environmental and formal work at once.',
    opener:
      'Look at what is being built now and the facades have thickness again — deep reveals, projecting fins, brise-soleil, recessed glazing, loggias cut into the massing. After two decades of pursuing the flushest possible plane, architecture has remembered that a facade with depth casts shadow, controls solar gain, sheds water and reads as a building rather than a rendering.',
    headings: [
      'The flush facade and what it cost',
      'Shadow as a material',
      'Solar control without shading devices',
      'Water, and the reason old buildings survive',
      'The thermal bridging tax',
    ],
    imageQuery: 'deep facade concrete brise soleil architecture',
  },
  {
    title: "Concrete's carbon problem and the three ways out",
    excerpt:
      'Cement is roughly eight per cent of global emissions. There are exactly three credible responses, and two of them are available today.',
    opener:
      'Concrete is the second most consumed substance on earth after water, and the calcination that makes cement releases carbon dioxide as a matter of chemistry, not combustion — you cannot fix it by changing the fuel. That constraint is what makes the problem hard, and it is also what narrows the credible responses down to three.',
    headings: [
      'Why the chemistry is the problem',
      'Use less: the specification route',
      'Substitute: cement replacements',
      'Capture: the expensive option',
      'What to do on a live project',
    ],
    imageQuery: 'exposed concrete architecture brutalist building',
  },
  {
    title: 'Daylight is a structural decision',
    excerpt:
      'By the time you are choosing window sizes, the daylight outcome was settled two months earlier — by the grid, the depth and the floor-to-floor.',
    opener:
      'Daylight gets treated as a facade problem, which is why so many buildings have generous glazing and gloomy interiors. The variables that actually govern how far light travels into a plan — floor-to-ceiling height, plan depth, structural depth at the perimeter, and where the columns land — are all fixed long before anyone opens a daylight model.',
    headings: [
      'The rule of thumb and its limits',
      'Floor-to-ceiling height does the work',
      'Structural depth at the perimeter',
      'Why the model arrives too late',
      'Designing the section first',
    ],
    imageQuery: 'daylight interior architecture atrium natural light',
  },
  {
    title: 'The thermal mass argument nobody finishes',
    excerpt:
      'Everyone agrees thermal mass matters. Almost nobody specifies for it, because the benefit shows up in a season and the cost shows up in a tender.',
    opener:
      'Thermal mass is the most agreed-upon and least acted-upon idea in environmental design. Exposed concrete soffits, masonry internal walls and stone floors all damp the daily temperature swing, shift peak cooling load into the night and can remove mechanical cooling entirely in the right climate. Then the ceiling gets a suspended raft for acoustics and services, and the mass is sealed away from the air it was supposed to condition.',
    headings: [
      'What mass actually does',
      'The night purge it depends on',
      'Why the ceiling always wins',
      'Climates where it does nothing',
      'Detailing for exposed soffits',
    ],
    imageQuery: 'exposed concrete soffit ceiling interior architecture',
  },
];

// ---------------------------------------------------------------------------
// Subject-specific sentence pools
// ---------------------------------------------------------------------------

const CLAIMS = [
  'The decision that matters is made at concept stage, not in technical design.',
  'Cost consultants price risk, not materials.',
  'The regulation is a floor, and treating it as a target is how buildings end up merely legal.',
  'Whole-life carbon and operational carbon point in different directions more often than the sector admits.',
  'Most of what looks like a detailing problem is a sequencing problem.',
  'The structural grid quietly determines about half the environmental performance.',
  'Buildability is a design constraint, not a compromise imposed afterwards.',
  'Post-occupancy evidence is scarce because nobody is paid to collect it.',
  'The performance gap is a construction problem far more than a design one.',
  'A material choice is really a supply-chain choice with an aesthetic attached.',
  'Servicing strategy and architectural expression are the same decision made twice.',
  'The tender is where most environmental ambition is quietly deleted.',
  'Maintenance access is designed last and determines how the building ages.',
  'Every facade is a compromise between three incompatible performance targets.',
  'Planning constraints shape more contemporary buildings than any design philosophy.',
  'The section carries more information than the plan and gets a fraction of the attention.',
  'Standardisation is the only reliable route to quality at volume.',
  'Thermal comfort is behavioural before it is thermal.',
  'Acoustic performance is the requirement most often discovered too late.',
  'The client brief is a hypothesis, not a specification.',
];

const ELABORATIONS = [
  'By the time a scheme reaches technical design the massing, orientation and structural strategy are fixed, and those three between them set the envelope of what any amount of specification can achieve.',
  'An unfamiliar system carries a risk premium that has nothing to do with its performance and everything to do with how many local contractors have built one before.',
  'Compliance was written to stop the worst buildings, which makes it a poor description of a good one — the gap between the two is where the actual design work lives.',
  'A highly efficient replacement can take thirty or forty years of operation to repay the carbon spent demolishing what stood there, which is longer than many commercial buildings are expected to last.',
  'Trades arrive in an order, and a junction that is elegant on a drawing can be impossible to execute once the preceding trade has left the site.',
  'Column spacing sets plan depth, plan depth sets how far daylight reaches, and how far daylight reaches sets how much artificial lighting and cooling the building needs for sixty years.',
  'A detail that cannot be built with the tolerances and skills actually available on site is not a detail, it is a drawing.',
  'Nobody commissions a study of their own completed building, so the profession keeps repeating decisions it has never checked.',
  'Insulation installed with gaps, thermal bridges introduced by fixings, and services penetrations sealed optimistically account for most of the difference between the model and the meter.',
  'Specifying a material with one regional supplier means accepting their lead time, their price movements and their quality control as project risk.',
  'Where the ducts run determines the floor-to-floor height, which determines the building height, which determines what the planning authority will accept.',
  'Value engineering rarely removes the structure or the envelope area; it removes the specification upgrades, which is precisely where the performance was.',
  'A facade that cannot be reached safely will not be cleaned or repaired, and a building that is not maintained fails at its junctions first.',
  'Solar control, daylight admission and view are three demands on the same aperture, and improving any one of them usually costs you another.',
  'Height limits, daylight-to-neighbour rules and massing guidance produce a envelope before an architect has drawn anything.',
  'Floor-to-ceiling height, structural depth and servicing zone interact in a way no plan drawing reveals, which is why section-led projects tend to be better resolved.',
  'A repeated bay that has been detailed once and built forty times will outperform forty bespoke bays detailed under time pressure.',
  'Occupants who can open a window, adjust a blind or move tolerate a much wider temperature range than those who cannot.',
  'Flanking transmission, impact noise and reverberation are governed by construction build-ups that are usually settled before an acoustician is appointed.',
  'Clients describe the building they can imagine, which is generally the last one they occupied, and the brief improves markedly once someone tests it.',
];

const EXAMPLES = [
  'A useful test: ask what the building would look like if the servicing strategy were reversed.',
  'On one recent scheme the entire environmental case rested on a night purge the facilities team switched off in month three.',
  'Try drawing the worst buildable version of your detail before the best one — it tends to be the one that gets built.',
  'The cheapest daylight intervention on most projects is 150mm of extra floor-to-ceiling height, decided at concept.',
  'Compare the embodied carbon of the frame against twenty years of operational savings; the answer reorders most priorities.',
  'One contractor priced the same facade three ways and the variation was almost entirely programme, not material.',
  'Walk the building at eight in the morning in February. That is the condition the drawings never test.',
  'The junction between the roof and the parapet is where you learn what the design team actually agreed.',
  'Ask the cost consultant which line they expect to be value-engineered, and design as though it already has been.',
  'On site, the question is never whether the detail works but whether it works when the preceding trade is two weeks late.',
];

const CAVEATS = [
  'This varies enormously by climate, and the temperate-maritime assumptions behind most of it do not travel.',
  'The counter-argument is that clients pay for area and view, not for the performance they cannot see.',
  'The evidence base here is thinner than the confidence with which it is usually quoted.',
  'None of this holds at small scale, where the fixed costs dominate everything else.',
  'There are procurement routes where this is simply not available to the design team.',
  'Refurbishment projects invert several of these assumptions, sometimes completely.',
  'That said, a well-executed conventional approach beats a badly-executed innovative one every time.',
  'The regulatory position is moving quickly enough that any specific figure here will date.',
];

const QUOTES = [
  'The greenest building is the one that is already built.',
  'Form follows finance, and always has.',
  'A building is a hypothesis about how people will live, tested at full scale over sixty years.',
  'Detail is not decoration. It is where the design either survives contact with water or does not.',
  'We shape our buildings; thereafter they shape us.',
];

const LIST_INTROS = [
  'What to check before the concept freezes:',
  'The questions worth asking at stage two:',
  'A short checklist, in the order the decisions actually arrive:',
];

const LIST_ITEMS = [
  'Fix the orientation and massing before discussing materials',
  'Model the section, not just the plan',
  'Get a whole-life carbon figure early enough to change something',
  'Name the line items you expect to lose at tender',
  'Confirm maintenance access for every external surface',
  'Test the brief against a building the client has not occupied',
  'Agree the servicing zone before the floor-to-floor is fixed',
];

const CLOSERS = [
  'None of this generalises perfectly across climates or procurement routes. Take the parts that survive contact with your own constraints.',
  'The short version: decide it at concept, write down why, and revisit when the answer stops feeling obvious.',
  'The expensive mistakes here are almost never the technical ones. They are the decisions made quickly and defended slowly.',
  'We will revisit this once there is post-occupancy data worth reading. That it does not yet exist is itself the finding.',
];

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** Draws without replacement so a long article does not visibly repeat. */
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

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

class ArchitectureContentEngine implements ContentEngine {
  readonly name = 'architecture-pack';

  async generateTitles(_topic: string, count: number): Promise<string[]> {
    return ARTICLES.slice(0, count).map((article) => article.title);
  }

  async generateExcerpt(title: string): Promise<string> {
    return ARTICLES.find((article) => article.title === title)?.excerpt ?? '';
  }

  async generateBody(request: OutlineRequest): Promise<ContentBlock[]> {
    const article = ARTICLES.find((entry) => entry.title === request.title);
    if (!article) throw new Error(`no article defined for "${request.title}"`);

    const random = seededRandom(request.seed ^ hashString(article.title));
    const blocks: ContentBlock[] = [];
    let words = 0;

    const push = (block: ContentBlock, text: string) => {
      blocks.push(block);
      words += text.split(/\s+/).filter(Boolean).length;
    };

    // The bespoke opener is what makes each piece read as its own subject
    // rather than as a template with the topic substituted in.
    push({ type: 'paragraph', text: article.opener }, article.opener);

    const claims = new Deck(CLAIMS, random);
    const elaborations = new Deck(ELABORATIONS, random);
    const examples = new Deck(EXAMPLES, random);
    const caveats = new Deck(CAVEATS, random);

    let quoteUsed = false;
    let listUsed = false;
    let index = 0;

    while (words < request.targetWords && index < article.headings.length * 2) {
      const heading = article.headings[index % article.headings.length]!;
      index += 1;
      push({ type: 'heading', level: 2, text: heading }, heading);

      const paragraphs = 2 + Math.floor(random() * 2);
      for (let i = 0; i < paragraphs && words < request.targetWords; i++) {
        const sentences = [claims.next(), elaborations.next()];
        const roll = random();
        if (roll > 0.62) sentences.push(examples.next());
        else if (roll > 0.34) sentences.push(caveats.next());
        const text = sentences.join(' ');
        push({ type: 'paragraph', text }, text);
      }

      if (!quoteUsed && words > request.targetWords * 0.35 && random() > 0.4) {
        quoteUsed = true;
        const quote = QUOTES[Math.floor(random() * QUOTES.length)]!;
        push(
          { type: 'quote', text: quote, attribution: 'Overheard at a design review' },
          quote
        );
      }

      if (!listUsed && words > request.targetWords * 0.5 && random() > 0.45) {
        listUsed = true;
        const intro = LIST_INTROS[Math.floor(random() * LIST_INTROS.length)]!;
        push({ type: 'paragraph', text: intro }, intro);
        const items = shuffle(LIST_ITEMS, random).slice(0, 4 + Math.floor(random() * 2));
        push({ type: 'list', ordered: random() > 0.5, items }, items.join(' '));
      }
    }

    const closer = CLOSERS[Math.floor(random() * CLOSERS.length)]!;
    push({ type: 'paragraph', text: closer }, closer);

    return blocks;
  }
}

// ---------------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const count = Math.min(Number(flag('count', '10')), ARTICLES.length);
const status: PublishStatus = process.argv.includes('--draft') ? 'draft' : 'published';
const slugArg = process.argv.indexOf('--site') >= 0 ? flag('site', '') : undefined;

const { slug, site } = await resolveSite(slugArg || undefined);
console.log(
  `Seeding ${count} contemporary-architecture posts into "${slug}" (${site.url})\n`
);

try {
  const report = await seedSite({
    site,
    topic: 'contemporary architecture',
    count,
    imageSource: 'stock',
    status,
    engine: new ArchitectureContentEngine(),
    seed: 20260814,
    onProgress: (phase, done, total, detail) => {
      if (phase === 'generating' || phase === 'publishing') {
        console.log(`  ${phase} ${done}/${total} — ${detail}`);
      }
    },
  });

  console.log(
    `\nTheme: ${report.capabilities.themeName} (confidence ${report.capabilities.confidence})`
  );
  console.log(`Created ${report.created} of ${count}, failed ${report.failed}`);
  console.log(`  feature images  ${report.generation.withFeatureImage}`);
  console.log(`  inline images   ${report.generation.withInlineImage}`);
  console.log(`  galleries       ${report.generation.withGallery}`);
  console.log(`  video embeds    ${report.generation.withVideo}`);

  for (const result of report.results.filter((r) => r.error)) {
    console.log(`  ! ${result.title}: ${result.error}`);
  }
  process.exit(report.failed > 0 ? 1 : 0);
} catch (err) {
  console.error(`\nFailed: ${describeError(err)}`);
  process.exit(1);
}
