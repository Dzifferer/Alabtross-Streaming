/**
 * Scoring helpers for TMDB auto-match. Extracted from server.js so the
 * pure functions can be unit-tested without booting the server.
 */

/**
 * Compute query-biased word overlap between a query (first arg) and a title.
 * Returns the fraction of query words that also appear in the title, after
 * lowercase + punctuation normalization.
 *
 * Asymmetric on purpose: franchise queries like "Harry Potter" or "Star Wars"
 * legitimately match longer titles ("Harry Potter and the Philosopher's Stone",
 * "Star Wars: The Force Awakens"). Dividing by the longer side would reject
 * those. Dividing by the query side still catches the failure mode we care
 * about — query words missing from the title — e.g. "Avatar Fire and Ash"
 * against "Avatar" scores 1/4 = 0.25 and is rejected.
 */
function titleWordOverlap(query, title) {
  const norm = s => (s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const wq = norm(query), wt = norm(title);
  if (wq.length === 0 || wt.length === 0) return 0;
  const common = wq.filter(w => wt.includes(w)).length;
  return common / wq.length;
}

module.exports = { titleWordOverlap };
