// content.js — original placeholder card content (not from CAH)
// Underline syntax: __like_this__ becomes a styled blank underline

window.PROMPT_CARDS = [
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
]

window.RESPONSE_CARDS = [
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

window.PLAYERS = [
  { name: 'Priya', avatar: 'P', score: 4, you: false },
  { name: 'You', avatar: 'Y', score: 3, you: true },
  { name: 'Rohan', avatar: 'R', score: 2, you: false },
  { name: 'Kavya', avatar: 'K', score: 2, you: false },
  { name: 'Marcus', avatar: 'M', score: 1, you: false },
  { name: 'Tomás', avatar: 'T', score: 0, you: false },
]

window.LOBBY_PLAYERS = [
  { name: 'Priya', avatar: 'P', host: true, ready: true, you: false },
  { name: 'You', avatar: 'Y', host: false, ready: true, you: true },
  { name: 'Rohan', avatar: 'R', host: false, ready: true, you: false },
  { name: 'Kavya', avatar: 'K', host: false, ready: false, you: false },
  { name: 'Marcus', avatar: 'M', host: false, ready: true, you: false },
]

window.LOBBY_SPECTATORS = [
  { name: 'Devika', avatar: 'D' },
  { name: 'Jaeho', avatar: 'J' },
  { name: 'Sam', avatar: 'S' },
]

window.CARD_PACKS = [
  {
    id: 'core',
    name: 'Core Pack',
    count: 460,
    desc: 'The essentials. Tame enough for most rooms.',
    on: true,
    locked: true,
  },
  {
    id: 'office',
    name: 'Office Hours',
    count: 120,
    desc: 'For the Slack-poisoned and meeting-pilled.',
    on: true,
    locked: false,
  },
  {
    id: 'desi',
    name: 'Bhayanak Desi',
    count: 180,
    desc: 'Auntie jokes, joint family chaos, IST suffering.',
    on: true,
    locked: false,
  },
  {
    id: 'online',
    name: 'Extremely Online',
    count: 95,
    desc: 'Memes, discourse, and posting-induced injuries.',
    on: false,
    locked: false,
  },
  {
    id: 'spicy',
    name: 'Spicy (18+)',
    count: 210,
    desc: 'PG-13 turned up. Lock the door.',
    on: false,
    locked: false,
  },
  {
    id: 'holidays',
    name: 'Festive Edition',
    count: 75,
    desc: 'Diwali, Christmas, and forced family gatherings.',
    on: false,
    locked: false,
  },
]

window.HOUSE_RULES = [
  {
    id: 'rebooting',
    name: 'Rebooting the Universe',
    desc: 'Trade a point to redraw your entire hand.',
  },
  { id: 'happy', name: 'Happy Ending', desc: 'Last round is judged by everyone, not the Judge.' },
  { id: 'haiku', name: 'Haiku Mode', desc: 'Submissions must fit 5-7-5. Loosely enforced.' },
  { id: 'godmode', name: 'God Is Dead', desc: 'No judge — everyone votes each round.' },
  { id: 'comeback', name: 'The Comeback', desc: 'Anyone tied for last picks two cards per round.' },
]
