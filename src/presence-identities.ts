// RoomHub deals one of these stable, non-personal identities to every
// anonymous share-link connection. Keep the deck shared so the server and
// the Roomling UI coverage gate cannot drift when an animal is added.
export const ANON_ANIMALS = [
  "otter", "heron", "lynx", "capybara", "ibex", "puffin", "gecko", "marmot",
  "narwhal", "kestrel", "axolotl", "wombat", "tapir", "quokka", "raven", "seal",
] as const;
