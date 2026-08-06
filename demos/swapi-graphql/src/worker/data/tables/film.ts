/** Columns selected from the `film` table. */
export const COLUMNS = [
  "id",
  "episode_id",
  "title",
  "opening_crawl",
  "director",
  "producer",
  "release_date",
  "created",
  "edited",
  "url",
] as const;

/** Exact D1 row shape selected from the `film` table. */
export interface FilmRow {
  id: string;
  episode_id: string;
  title: string;
  opening_crawl: string;
  director: string;
  producer: string;
  release_date: string;
  created: string;
  edited: string;
  url: string;
}

/** Application representation of a film. */
export interface Film {
  id: string;
  episodeId: string;
  title: string;
  openingCrawl: string;
  director: string;
  producer: string;
  releaseDate: string;
  created: string;
  edited: string;
  url: string;
}

/** Maps one database row to the film domain representation. @param row D1 result row. @returns A film. */
export function mapFilm(row: FilmRow): Film {
  return {
    id: row.id,
    episodeId: row.episode_id,
    title: row.title,
    openingCrawl: row.opening_crawl,
    director: row.director,
    producer: row.producer,
    releaseDate: row.release_date,
    created: row.created,
    edited: row.edited,
    url: row.url,
  };
}
