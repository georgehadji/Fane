// Which feature answers a phrasing. The detectors share their polite openings (core/polite.mjs); this table runs every
// phrasing through all of them in autoRoute's order (brainstorm, code, post, article), so a wording that one feature
// accepts cannot fall through to a plain search in another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isArticleRequest, postPlatform } from '../core/intent-article.mjs';
import { isCodeRequest } from '../core/intent-code.mjs';
import { isBrainstormRequest } from '../core/intent-brainstorm.mjs';

const hits = (q) => [
  isBrainstormRequest(q) && 'brainstorm', isCodeRequest(q) && 'code', postPlatform(q) && 'post', isArticleRequest(q) && 'article',
].filter(Boolean);

const TABLE = {
  article: [
    'Write an article about solar power', 'please write an article about solar power', 'Could you write an essay on Plato',
    'I need you to write an article about quantum computing', 'Help me write a blog post about sourdough', "Let's write an article about remote work",
    'I want you to write a report on EU energy policy', "I'd like you to draft an essay about Stoicism", 'Παρακαλώ γράψε ένα άρθρο για την ενέργεια',
    'Help me draft an essay on the French Revolution',
  ],
  post: [
    'Write a LinkedIn post about our launch', 'Please write a Facebook post about the sale', 'I need you to write a LinkedIn post about hiring',
    'Help me write a LinkedIn post about my promotion', "Let's write a Facebook post about the open day",
  ],
  code: [
    'Write a Python script that renames photos by date', 'Please write a function to merge two sorted lists', 'I need you to write a CLI tool for converting CSV to JSON',
    'Help me write a script that deletes old logs', "Let's build a REST API in Go", "I'd like you to create a bash script to back up my home folder",
    'I want you to implement quicksort in Rust', 'Παρακαλώ γράψε ένα πρόγραμμα σε Python που μετράει λέξεις',
  ],
  brainstorm: [
    'Brainstorm names for a coffee shop', 'Please brainstorm names for a bakery', 'I want you to brainstorm names for a bakery',
    "I'd like you to brainstorm ideas for a podcast", 'Help me brainstorm slogans for a gym', "Let's brainstorm titles for my essay collection",
    'I need you to suggest names for my bakery', 'Could you give me 10 ideas for a birthday party', 'Παρακαλώ δώσε μου ιδέες για ένα καφέ',
  ],
  none: [
    'What is the capital of France', 'a list of tools for writing', 'an image classifier in Python', 'The best Python script for renaming files',
    'ideas for dinner', 'Please tell me the weather in Athens', 'I need you to explain how TLS works', 'Help me understand monads', "Let's talk about databases",
    'Can you recommend a good book on Rust', 'I want you to know that I like coffee', 'What are good ideas for a startup',
  ],
};

for (const [route, phrasings] of Object.entries(TABLE)) {
  test(`routing: ${route}`, () => {
    for (const q of phrasings) {
      // a post may also read as an article («ανάρτηση»); autoRoute asks for the post first
      const got = hits(q).filter((h, i, all) => !(h === 'article' && all.includes('post')));
      assert.deepEqual(got, route === 'none' ? [] : [route], q);
    }
  });
}
