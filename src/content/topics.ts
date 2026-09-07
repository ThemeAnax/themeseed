/**
 * Fallback subjects for a seed run nobody gave a topic to.
 *
 * Previewing a theme does not require the copy to be about anything in
 * particular — it requires headlines of realistic length, prose that wraps the
 * way real prose wraps, and enough variety that two posts do not look like the
 * same post twice. Any of these delivers that.
 *
 * They are deliberately ordinary publication subjects rather than lorem-ipsum
 * filler: a designer judging a theme reads the words, and "Consectetur adipiscing
 * elit" tells them nothing about how a real headline sits in the layout.
 */

const TOPICS = [
  'independent coffee roasting and café culture',
  'urban cycling and city infrastructure',
  'home cooking with seasonal ingredients',
  'long-distance hiking and backcountry gear',
  'film photography and darkroom technique',
  'small-space gardening and houseplants',
  'vintage watch collecting and restoration',
  'modern board game design',
  'sustainable interior design',
  'freshwater fly fishing',
  'classical guitar and lutherie',
  'amateur astronomy and night-sky photography',
] as const;

/** Every fallback topic, in declaration order. */
export function demoTopics(): readonly string[] {
  return TOPICS;
}

/**
 * One topic at random.
 *
 * Takes an optional seed so a caller that wants a reproducible run can have
 * one; without it, two seed runs in the same session produce different
 * publications, which is what makes repeated previews useful.
 */
export function randomTopic(seed?: number): string {
  const index =
    seed === undefined
      ? Math.floor(Math.random() * TOPICS.length)
      : Math.abs(Math.trunc(seed)) % TOPICS.length;
  return TOPICS[index] ?? TOPICS[0];
}
