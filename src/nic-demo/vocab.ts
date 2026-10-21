/**
 * Small deterministic vocabularies for the item types the prose engine has no
 * opinion about (people, projects, services, products). Like the engine's own
 * decks, these exist to make a theme look populated, not to be read closely.
 */

export const FIRST_NAMES = [
  'Ana',
  'Ben',
  'Priya',
  'Marco',
  'Sofia',
  'Daniel',
  'Amara',
  'Lucas',
  'Mei',
  'Jonas',
  'Leila',
  'Tomas',
  'Nadia',
  'Oliver',
  'Ines',
  'Kwame',
  'Hannah',
  'Rafael',
  'Yuki',
  'Elena',
  'Samir',
  'Clara',
  'Diego',
  'Freya',
] as const;

export const LAST_NAMES = [
  'Lima',
  'Okafor',
  'Brandt',
  'Moreau',
  'Tanaka',
  'Hughes',
  'Rossi',
  'Nguyen',
  'Larsen',
  'Haddad',
  'Costa',
  'Ivanova',
  'Walker',
  'Mehta',
  'Duarte',
  'Kowalski',
  'Santos',
  'Fischer',
  'Adeyemi',
  'Lindqvist',
  'Bauer',
  'Quinn',
  'Silva',
  'Novak',
] as const;

export const ROLES = [
  'Founder',
  'Creative Director',
  'Senior Advisor',
  'Operations Lead',
  'Client Partner',
  'Head of Design',
  'Account Manager',
  'Project Lead',
  'Specialist',
  'Content Lead',
  'Community Manager',
  'Studio Manager',
] as const;

export const COMPANIES = [
  'Harbour & Co',
  'Lumen Works',
  'Fernhill Group',
  'Alder Street Studio',
  'Northgate Partners',
  'Bluebird Collective',
  'Copperleaf',
  'Westmoor Trading',
  'Kite & Compass',
  'Ironbridge Labs',
  'Marlow House',
  'Tidewater Foods',
] as const;

export const PROJECT_ADJECTIVES = [
  'Harbour',
  'Meadow',
  'Summit',
  'Lantern',
  'Orchard',
  'Cedar',
  'Atlas',
  'Ember',
  'Willow',
  'Northern',
] as const;

export const PROJECT_NOUNS = [
  'Residence',
  'Campaign',
  'Collection',
  'Project',
  'Redesign',
  'Retreat',
  'Launch',
  'Studio',
] as const;

export const SERVICE_TITLES = [
  'Strategy & Planning',
  'Concierge Support',
  'Custom Design',
  'Expert Consultation',
  'Ongoing Care',
  'Workshops & Training',
  'Audits & Reviews',
  'Implementation',
  'Research & Discovery',
  'Maintenance Plans',
  'Priority Support',
  'Group Programmes',
] as const;

export const SERVICE_ICONS = [
  '✨',
  '🧭',
  '🎯',
  '💡',
  '🛡️',
  '🌿',
  '📐',
  '🤝',
  '🔧',
  '⭐',
  '🗓️',
  '💬',
] as const;

export const PRODUCT_ADJECTIVES = [
  'Coastal',
  'Classic',
  'Everyday',
  'Signature',
  'Weekend',
  'Premium',
  'Essential',
  'Heritage',
  'Compact',
  'Deluxe',
] as const;

export const PRODUCT_NOUNS = [
  'Kit',
  'Bundle',
  'Set',
  'Edition',
  'Pack',
  'Collection',
  'Box',
  'Selection',
] as const;

export const BASE_PRICES = [19, 24, 39, 49, 59, 79, 99, 129, 149, 199, 249, 349] as const;

export const CATEGORY_NAMES = [
  'Guides',
  'Stories',
  'News',
  'Behind the scenes',
  'Tips',
  'Ideas',
] as const;
export const TAG_NAMES = [
  'Beginners',
  'Planning',
  'Inspiration',
  'Checklist',
  'How-to',
  'Trends',
  'Lessons',
  'Community',
] as const;
export const PORTFOLIO_CATEGORY_NAMES = [
  'Featured',
  'Recent work',
  'Case studies',
  'Collaborations',
] as const;
export const PRODUCT_CATEGORY_NAMES = [
  'Essentials',
  'Premium',
  'Gift ideas',
  'New arrivals',
] as const;
export const PRODUCT_TAG_NAMES = ['Bestseller', 'Limited', 'New'] as const;

/** `{subject}` is replaced with the topic's subject. */
export const TESTIMONIAL_QUOTES = [
  'We arrived with a vague idea about {subject} and left with a plan we actually trusted. Everything landed on time and the small details were handled before we had to ask.',
  'Honest advice, no upselling, and a genuine feel for {subject}. I would not hesitate to recommend them to friends.',
  'Something went sideways at the last minute and it was sorted before we even noticed. That is the difference experience makes.',
  'Warm, quick to reply and refreshingly practical. Our experience of {subject} was far smoother than we had expected.',
  'They listened first, then proposed. The result felt like it was made for us rather than pulled off a shelf.',
] as const;

export interface TravelDestination {
  place: string;
  country: string;
  stops: readonly string[];
}

/** Travel-topic product vocabulary: package = place + experience. */
export const DESTINATIONS: readonly TravelDestination[] = [
  { place: 'Santorini', country: 'Greece', stops: ['Fira', 'Oia', 'Akrotiri'] },
  { place: 'Kyoto', country: 'Japan', stops: ['Gion', 'Arashiyama', 'Fushimi'] },
  { place: 'Amalfi', country: 'Italy', stops: ['Positano', 'Ravello', 'Sorrento'] },
  {
    place: 'Marrakech',
    country: 'Morocco',
    stops: ['Medina', 'Atlas Foothills', 'Essaouira'],
  },
  {
    place: 'Patagonia',
    country: 'Chile',
    stops: ['Torres del Paine', 'Puerto Natales', 'Grey Glacier'],
  },
  { place: 'Seychelles', country: 'Seychelles', stops: ['Mahé', 'Praslin', 'La Digue'] },
  { place: 'Lisbon', country: 'Portugal', stops: ['Alfama', 'Sintra', 'Cascais'] },
  { place: 'Bali', country: 'Indonesia', stops: ['Ubud', 'Uluwatu', 'Nusa Penida'] },
  {
    place: 'Reykjavik',
    country: 'Iceland',
    stops: ['Golden Circle', 'Vik', 'Blue Lagoon'],
  },
  {
    place: 'Serengeti',
    country: 'Tanzania',
    stops: ['Seronera', 'Ngorongoro', 'Tarangire'],
  },
  { place: 'Provence', country: 'France', stops: ['Aix', 'Luberon', 'Gordes'] },
  {
    place: 'Dubrovnik',
    country: 'Croatia',
    stops: ['Old Town', 'Lokrum', 'Elaphiti Islands'],
  },
  {
    place: 'Cusco',
    country: 'Peru',
    stops: ['Sacred Valley', 'Ollantaytambo', 'Machu Picchu'],
  },
  {
    place: 'Phuket',
    country: 'Thailand',
    stops: ['Old Town', 'Phi Phi', 'Phang Nga Bay'],
  },
  { place: 'Zanzibar', country: 'Tanzania', stops: ['Stone Town', 'Nungwi', 'Jozani'] },
  {
    place: 'Tuscany',
    country: 'Italy',
    stops: ['Florence', 'Siena', 'Val d\u2019Orcia'],
  },
  {
    place: 'Queenstown',
    country: 'New Zealand',
    stops: ['Milford Sound', 'Arrowtown', 'Wanaka'],
  },
  { place: 'Petra', country: 'Jordan', stops: ['Wadi Rum', 'Amman', 'Dead Sea'] },
  {
    place: 'Cape Town',
    country: 'South Africa',
    stops: ['Table Mountain', 'Stellenbosch', 'Cape Point'],
  },
  { place: 'Fiji', country: 'Fiji', stops: ['Denarau', 'Yasawa Islands', 'Taveuni'] },
];

export const TRAVEL_EXPERIENCES = [
  'Escape',
  'Retreat',
  'Discovery',
  'Getaway',
  'Highlights',
  'Journey',
  'Hideaway',
  'Odyssey',
] as const;

export const TRAVEL_FLAVOURS = ['Hidden', 'Golden', 'Slow', 'Secret', 'Grand'] as const;
