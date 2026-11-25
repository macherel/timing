import type { Participant } from '../types';

/** Lower case without accents, so "eloise" finds "Éloïse". */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Cost of matching one search word against a participant, lower is better. null when it does not match.
 * A number is looked up in the bib, any word in the name.
 */
function wordCost(word: string, bib: string, name: string): number | null {
  if (/^\d+$/.test(word)) {
    if (bib === word) return 0;
    if (bib.startsWith(word)) return 1;
    if (bib.includes(word)) return 3;
  }
  if (name.split(/[\s'-]+/).some((part) => part.startsWith(word))) return 2;
  if (name.includes(word)) return 4;
  return null;
}

/**
 * Participants matching a partial bib and/or a partial name, best matches first, at most `limit` of them.
 * Every word of the query must match: "12 dup" finds bib 12x whose name contains a word starting with "dup".
 * An empty query returns the complete list (sorted by bib, not limited), to browse it.
 */
export function searchParticipants<T extends Participant>(participants: T[], query: string, limit: number): T[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return participants;

  const matches: { participant: T; cost: number }[] = [];
  for (const participant of participants) {
    const name = normalize(participant.name);
    let cost = 0;
    for (const word of words) {
      const wordMatch = wordCost(word, participant.bib, name);
      if (wordMatch === null) {
        cost = -1;
        break;
      }
      cost += wordMatch;
    }
    if (cost >= 0) matches.push({ participant, cost });
  }

  return matches
    .sort((a, b) => a.cost - b.cost || Number(a.participant.bib) - Number(b.participant.bib))
    .slice(0, limit)
    .map((match) => match.participant);
}
