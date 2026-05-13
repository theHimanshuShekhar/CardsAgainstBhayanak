export const PROMPT_CARDS = [
  { text: "What's the one thing that ruins every team offsite? __________.", blanks: 1 },
  { text: 'I never truly understood __________ until I tried __________.', blanks: 2 },
  {
    text: 'My ideal Sunday: wake up to __________, spend the afternoon with __________, and end it all with __________.',
    blanks: 3,
  },
  {
    text: "My therapist told me to stop blaming __________ for everything. I'm not going to.",
    blanks: 1,
  },
  { text: 'The official slogan for our generation is: "__________."', blanks: 1 },
  { text: 'Why am I crying in the Wegmans parking lot again? __________.', blanks: 1 },
  { text: 'Tonight on the news: "__________ shocks the nation."', blanks: 1 },
  { text: "What's the secret ingredient in grandma's stew? __________.", blanks: 1 },
  {
    text: 'The new self-help bestseller is titled "How to __________ Without __________."',
    blanks: 2,
  },
  { text: "What's my emotional support animal? __________.", blanks: 1 },
  { text: 'What did I find in the back of the fridge? __________.', blanks: 1 },
] as const

export const RESPONSE_CARDS: readonly string[] = [
  'A surprisingly aggressive pigeon.',
  'Reading the terms and conditions.',
  "My mom's WhatsApp group chat.",
  'Three raccoons in a trench coat.',
  'Passive-aggressive Slack reactions.',
  'The intern who keeps saying "pivot."',
  'A LinkedIn poll about hustle culture.',
  'Whatever Mercury is doing right now.',
  'Crying in the cereal aisle.',
  'An IKEA assembly manual in Swedish.',
  'The third margarita.',
  'Yelling at a kiosk.',
  "My ex's new haircut.",
  'Aggressive eye contact during karaoke.',
  'Sending "k." and meaning it.',
  'A motivational poster that just says "NO."',
  'The smell of a Bath & Body Works.',
  'Forgetting why I walked into this room.',
  'The exact wrong amount of confidence.',
  'Pretending to know what NFTs are.',
]

export const STUB_PLAYERS = [
  { name: 'Priya', avatar: 'P', score: 4, you: false },
  { name: 'You', avatar: 'Y', score: 3, you: true },
  { name: 'Rohan', avatar: 'R', score: 2, you: false },
  { name: 'Kavya', avatar: 'K', score: 2, you: false },
  { name: 'Marcus', avatar: 'M', score: 1, you: false },
  { name: 'Tomás', avatar: 'T', score: 0, you: false },
]

export const STUB_LOBBY_PLAYERS = [
  { name: 'Priya', host: true, you: false },
  { name: 'You', host: false, you: true },
  { name: 'Rohan', host: false, you: false },
  { name: 'Kavya', host: false, you: false },
  { name: 'Marcus', host: false, you: false },
]

export const STUB_LOBBY_SPECTATORS = [{ name: 'Devika' }, { name: 'Jaeho' }, { name: 'Sam' }]

export const STUB_PACKS = [
  {
    id: 'core',
    name: 'Core Pack',
    count: 460,
    desc: 'The essentials. Tame enough for most rooms.',
    locked: true,
  },
  {
    id: 'office',
    name: 'Office Hours',
    count: 120,
    desc: 'For the Slack-poisoned and meeting-pilled.',
    locked: false,
  },
  {
    id: 'desi',
    name: 'Bhayanak Desi',
    count: 180,
    desc: 'Auntie jokes, joint family chaos, IST suffering.',
    locked: false,
  },
  {
    id: 'online',
    name: 'Extremely Online',
    count: 95,
    desc: 'Memes, discourse, and posting-induced injuries.',
    locked: false,
  },
  {
    id: 'spicy',
    name: 'Spicy (18+)',
    count: 210,
    desc: 'PG-13 turned up. Lock the door.',
    locked: false,
  },
  {
    id: 'holidays',
    name: 'Festive Edition',
    count: 75,
    desc: 'Diwali, Christmas, and forced family gatherings.',
    locked: false,
  },
] as const

export const HOUSE_RULES = [
  {
    id: 'rebooting' as const,
    kind: 'orthogonal' as const,
    name: 'Rebooting the Universe',
    desc: 'Trade a point to redraw your entire hand.',
  },
  {
    id: 'packing_heat' as const,
    kind: 'orthogonal' as const,
    name: 'Packing Heat',
    desc: 'On pick-2 cards, draw an extra white card.',
  },
  {
    id: 'rando' as const,
    kind: 'orthogonal' as const,
    name: 'Rando Cardrissian',
    desc: 'A random card plays each round. If Rando wins, you all go home in shame.',
  },
  {
    id: 'godmode' as const,
    kind: 'modal' as const,
    name: 'God Is Dead',
    desc: 'No Czar; everyone votes.',
  },
  {
    id: 'survival' as const,
    kind: 'modal' as const,
    name: 'Survival of the Fittest',
    desc: 'Players eliminate cards until one remains.',
  },
  {
    id: 'serious_business' as const,
    kind: 'modal' as const,
    name: 'Serious Business',
    desc: 'Czar ranks top 3 (3/2/1 points).',
  },
  {
    id: 'never_have_i_ever' as const,
    kind: 'orthogonal' as const,
    name: 'Never Have I Ever',
    desc: "Discard cards you don't get (with confession). Max 3 per game.",
  },
  {
    id: 'happy_ending' as const,
    kind: 'orthogonal' as const,
    name: 'Happy Ending',
    desc: 'Host may end the game early with a haiku final round.',
  },
] as const

export type HouseRule = (typeof HOUSE_RULES)[number]
