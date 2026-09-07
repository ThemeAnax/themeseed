import { describe, expect, it } from 'vitest';

import { demoTopics, randomTopic } from '../../src/content/topics.js';

describe('demoTopics', () => {
  it('offers several distinct subjects', () => {
    const topics = demoTopics();
    expect(topics.length).toBeGreaterThan(5);
    expect(new Set(topics).size).toBe(topics.length);
  });

  it('reads as real publication subjects, not filler', () => {
    for (const topic of demoTopics()) {
      expect(topic).not.toMatch(/lorem|ipsum|placeholder|example/i);
      expect(topic.split(' ').length).toBeGreaterThan(1);
    }
  });
});

describe('randomTopic', () => {
  it('always returns one of the deck', () => {
    const topics = new Set(demoTopics());
    for (let i = 0; i < 50; i++) expect(topics.has(randomTopic())).toBe(true);
  });

  it('is reproducible when seeded', () => {
    expect(randomTopic(7)).toBe(randomTopic(7));
  });

  it('handles a negative seed without falling off the deck', () => {
    expect(demoTopics()).toContain(randomTopic(-3));
  });
});
