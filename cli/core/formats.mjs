// Social posts: the same research and fact-check as an article, written to a platform's rules.
// One table, read by the intent, the prompts, the checks, the pipeline, the web answer and the CLI.
// Figures (2026, mostly from tool vendors; check in the platform's own composer):
//  - LinkedIn: 3,000 characters at most; the feed folds at about 210 characters on desktop, 140 on mobile.
//    A link in the post body cut median reach by 18.8% (van der Blom, ~1.3M posts), so links go in the first comment.
//  - Facebook: the limit is far above any post; the feed folds at about 125 characters on mobile, 477 on desktop.
//    Meta has been testing a cap of two organic link posts a month for unverified Pages; comments are not capped.
export const POSTS = {
  linkedin: { name: 'LinkedIn', words: 220, minWords: 60, maxWords: 450, maxChars: 3000, foldChars: 210, hashtags: 3 },
  facebook: { name: 'Facebook', words: 120, minWords: 30, maxWords: 350, maxChars: 63206, foldChars: 125, hashtags: 0 },
};
export const POST_PLATFORMS = Object.keys(POSTS);
// A request for a post that names no platform: LinkedIn, the text-first one.
export const DEFAULT_PLATFORM = 'linkedin';

export const isPost = (format) => Object.hasOwn(POSTS, String(format));
export const clampPostWords = (n, platform) => {
  const p = POSTS[platform];
  return Math.min(p.maxWords, Math.max(p.minWords, Math.round(Number(n) || p.words)));
};
