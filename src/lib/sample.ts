import type { CommitRecord, Repository, Viewer } from '../../shared/types.ts';

export const SAMPLE_USER: Viewer = { id: 'sample-developer', login: 'alexmorgan', avatarUrl: '' };
export const SAMPLE_AS_OF = '2026-09-29T12:00:00.000Z';
export const SAMPLE_REPOSITORIES: Repository[] = [
  { id: 'sample-1', nameWithOwner: 'alexmorgan/waypoint', isPrivate: false, isFork: false, isArchived: false, description: 'A small app for finding your next trail.' },
  { id: 'sample-2', nameWithOwner: 'alexmorgan/react-native-kit', isPrivate: false, isFork: false, isArchived: false, description: 'Reusable building blocks for mobile apps.' },
  { id: 'sample-3', nameWithOwner: 'alexmorgan/tiny-tools', isPrivate: false, isFork: false, isArchived: false, description: 'Useful weekend projects.' },
  { id: 'sample-4', nameWithOwner: 'alexmorgan/studio', isPrivate: true, isFork: false, isArchived: false, description: 'Private side projects.' },
];

// Synthetic, deterministic history for the explicitly labeled sample experience.
// These numbers are not fetched from or attributed to a real GitHub account.
export const SAMPLE_COMMITS: CommitRecord[] = [];
let sequence = 1;
for (let year = 2019; year <= 2026; year += 1) {
  for (let month = 0; month < 12; month += 1) {
    if (year === 2026 && month > 8) break;
    const later = year > 2025 || (year === 2025 && month >= 9);
    const count = later ? 18 + ((month * 7 + year) % 13) : 4 + ((month + year) % 6);
    for (let index = 0; index < count; index += 1) {
      const day = 1 + Math.floor(index * 27 / count);
      const committedDate = new Date(Date.UTC(year, month, day, 12, index % 60)).toISOString();
      const additions = later ? 600 + ((sequence * 157) % 2100) : 45 + ((sequence * 73) % 260);
      SAMPLE_COMMITS.push({
        oid: sequence.toString(16).padStart(40, '0'), committedDate, additions,
        deletions: Math.floor(additions * (later ? 0.27 : 0.39)),
        authorId: SAMPLE_USER.id, parentCount: sequence === 1 ? 0 : 1,
      });
      sequence += 1;
    }
  }
}
