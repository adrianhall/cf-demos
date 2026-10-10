import { defineStore } from "pinia";

/** Link record returned by the same-origin management API. */
export interface ShortLink {
  /** Immutable identifier used in the public short URL. */
  code: string;
  /** Redirect target. */
  destination: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp for the latest update. */
  updatedAt: string;
}

/** RFC 9457 response fields displayed to the administrator. */
interface ProblemDetails {
  /** User-safe explanation of a failed request. */
  detail?: string;
  /** Standard status text fallback. */
  title?: string;
}

/** Convert an unsuccessful same-origin API response into a user-safe error. */
async function requestError(response: Response): Promise<Error> {
  try {
    const problem = (await response.json()) as ProblemDetails;
    return new Error(
      problem.detail ?? problem.title ?? "The request could not be completed.",
    );
  } catch {
    return new Error("The request could not be completed.");
  }
}

/** Execute a JSON API request and return the decoded response value. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    throw await requestError(response);
  }
  return (await response.json()) as T;
}

/** Shared client state and CRUD actions for short links. */
export const useLinksStore = defineStore("links", {
  actions: {
    /** Create a link then place it at the top of the local list. */
    async create(destination: string): Promise<ShortLink> {
      const response = await request<{ link: ShortLink }>("/api/links", {
        body: JSON.stringify({ destination }),
        method: "POST",
      });
      this.links.unshift(response.link);
      return response.link;
    },

    /** Delete one link and remove it from local state after success. */
    async delete(code: string): Promise<void> {
      const response = await fetch(`/api/links/${encodeURIComponent(code)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw await requestError(response);
      }
      this.links = this.links.filter((link) => link.code !== code);
    },

    /** Fetch the current administrative link list. */
    async load(): Promise<void> {
      this.loading = true;
      try {
        const response = await request<{ links: ShortLink[] }>("/api/links");
        this.links = response.links;
      } finally {
        this.loading = false;
      }
    },

    /** Replace a destination and merge the server-confirmed value into local state. */
    async update(code: string, destination: string): Promise<ShortLink> {
      const response = await request<{ link: ShortLink }>(
        `/api/links/${encodeURIComponent(code)}`,
        {
          body: JSON.stringify({ destination }),
          method: "PUT",
        },
      );
      this.links = this.links.map((link) =>
        link.code === code ? response.link : link,
      );
      return response.link;
    },
  },
  state: () => ({
    /** Most recently created or fetched links. */
    links: [] as ShortLink[],
    /** Whether the initial list request is pending. */
    loading: false,
  }),
});
